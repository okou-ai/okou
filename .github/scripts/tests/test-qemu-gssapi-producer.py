#!/usr/bin/env python3
"""Public inert input tests; no QEMU/helper/signature/runtime is impersonated."""
import ast
import hashlib
import importlib.util
import json
import os
import pathlib
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location("qemu_producer", ROOT / ".github/scripts/prepare-qemu-gssapi-fixture.py")


class ProducerInputs(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.producer = importlib.util.module_from_spec(SPEC)
        SPEC.loader.exec_module(cls.producer)
        cls.parent = ROOT / "crates/target/qemu-gssapi-runtime-tests"
        cls.parent.mkdir(parents=True, exist_ok=True)
        assert cls.parent.resolve() == cls.parent and not cls.parent.is_symlink()

    def test_native_elf_machine_is_bound_to_selected_architecture(self):
        for arch, machine in (("x86_64", 62), ("aarch64", 183)):
            # Header-only nonexecutable parser canary, never a fake native image.
            header = bytearray(64)
            header[:6] = b"\x7fELF\x02\x01"
            header[18:20] = machine.to_bytes(2, "little")
            self.producer.verify_elf_header(bytes(header), arch)
            other = "aarch64" if arch == "x86_64" else "x86_64"
            with self.assertRaises(ValueError):
                self.producer.verify_elf_header(bytes(header), other)
        with self.assertRaises(ValueError):
            self.producer.verify_elf_header(b"public non-ELF canary", "x86_64")

    def test_archive_names_cannot_escape_source_root(self):
        for name in ("qemu-9.2.0/../escape", "/absolute", "other/file", "qemu-9.2.0/a/../../b"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.producer.source_member(name)
        self.assertEqual(self.producer.source_member("qemu-9.2.0/ui/vnc-auth-sasl.c"), pathlib.PurePosixPath("ui/vnc-auth-sasl.c"))

    def test_regular_inventory_rejects_escaped_symlink_without_reading_target(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            root = pathlib.Path(directory)
            (root / "public.canary").write_bytes(b"inert public inventory canary")
            (root / "escape").symlink_to("../outside")
            with self.assertRaises(ValueError):
                self.producer.inventory(root)

    def test_contained_alias_identity_and_regular_digest_are_preserved(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            root = pathlib.Path(directory)
            data = b"inert public inventory canary"
            (root / "public.canary").write_bytes(data)
            (root / "alias").symlink_to("public.canary")
            tree, digest = self.producer.inventory(root)
            self.assertEqual(tree['schemaVersion'], 2)
            self.assertEqual(set(tree['nodes']), {'.', 'public.canary', 'alias'})
            self.assertEqual(tree['nodes']['public.canary']['sha256'], hashlib.sha256(data).hexdigest())
            self.assertEqual(tree['nodes']['alias']['target'], 'public.canary')
            self.assertEqual(tree['nodes']['alias']['resolution']['kind'], 'regular')
            self.assertEqual(digest, hashlib.sha256(b'qemu-full-private-tree-v2\x00' + json.dumps(
                tree, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()).hexdigest())

    def test_fresh_driver_creates_only_its_ignored_target_parent(self):
        # Execute only real shell preflight in an inert, local miniature repo.
        # No producer, archive fetch, native program or receipt runs here.
        prefix = (ROOT / ".github/scripts/check-full-qemu-producer.sh").read_text().split("\nsource_cache=", 1)[0]
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            root = pathlib.Path(directory)
            (root / "crates").mkdir()
            (root / ".gitignore").write_text("/crates/target/\n")
            subprocess.run(["git", "init", "--quiet", str(root)], check=True, timeout=10)
            result = subprocess.run(["bash", "-c", prefix], cwd=root, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((root / "crates/target/full-qemu-producer-receipt").is_dir())

    def test_driver_does_not_rebind_binary_digest_to_signed_index(self):
        # Structural metadata-binding guard, not native/runtime evidence.
        body = (ROOT / ".github/scripts/check-full-qemu-producer.sh").read_text().split("<<'PY'\n", 1)[1].rsplit("\nPY", 1)[0]
        for node in ast.walk(ast.parse(body)):
            if isinstance(node, ast.For):
                self.assertNotIn("digest", [name.id for name in ast.walk(node.target) if isinstance(name, ast.Name)])

    def test_private_apt_startup_excludes_ambient_main_fragments_and_hooks(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            base = pathlib.Path(directory).resolve()
            self.producer.private_apt_config(base, "amd64")
            # The real APT startup/configuration boundary, without update,
            # downloads, hooks, package installation or host changes.
            config = self.producer.call(["apt-config", "dump"], cwd=base)
            for setting in ('Dir::Etc::Parts "-";', 'Dir::Etc::Main "-";', 'Dir::Etc::trusted "-";'):
                self.assertTrue(setting.lower() in config.lower(), "private APT startup was not selected")
            for hook in ("APT::Update::Post-Invoke", "APT::Update::Pre-Invoke", "DPkg::Pre-Invoke", "DPkg::Post-Invoke"):
                self.assertTrue(hook not in config, "ambient hook survived private startup")

    def test_source_required_posix_shell_is_an_explicit_signed_seed(self):
        self.assertIn('dash', self.producer.REQUIRED)
        self.assertEqual(self.producer.SEEDS['dash'], '0.5.12-6ubuntu5')

    def test_source_required_firmware_unpacker_is_an_explicit_signed_seed(self):
        self.assertIn('bzip2', self.producer.REQUIRED)
        self.assertEqual(self.producer.SEEDS['bzip2'], '1.0.8-5.1')
        # The selected x86_64-softmmu/installed-blob Meson path needs the
        # executable, not just libbz2. This is a source boundary, not a build.
        module = ast.parse((ROOT / '.github/scripts/prepare-qemu-gssapi-fixture.py').read_text())
        preflight = next(node for node in module.body if isinstance(node, ast.FunctionDef)
                         and node.name == 'required_build_inputs')
        roles = [node.value for node in ast.walk(preflight) if isinstance(node, ast.Constant)]
        self.assertIn('usr/bin/bzip2', roles)

    def test_unconditional_schema_setup_and_source_tools_are_explicit_inputs(self):
        self.assertIn('diffutils', self.producer.REQUIRED)
        self.assertEqual(self.producer.SEEDS['diffutils'], '1:3.10-1build1')
        # Reviewed configure/generator/compiler paths, not their execution or
        # complete transitive loader attribution. diff lookup is unconditional.
        module = ast.parse((ROOT / '.github/scripts/prepare-qemu-gssapi-fixture.py').read_text())
        preflight = next(node for node in module.body if isinstance(node, ast.FunctionDef)
                         and node.name == 'required_build_inputs')
        roles = {node.value for node in ast.walk(preflight) if isinstance(node, ast.Constant)
                 and isinstance(node.value, str)}
        for name in ('diff', 'expr', 'tr', 'date', 'dirname', 'basename', 'rm', 'mkdir',
                     'ln', 'mv', 'cat', 'chmod', 'sort', 'nm', 'ar', 'as'):
            self.assertIn('usr/bin/' + name, roles)
        self.assertIn('/13/cc1', roles)
        self.assertIn('/13/collect2', roles)

    def test_required_program_preflight_refuses_missing_interpreter_without_execution(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            with self.assertRaisesRegex(ValueError, 'required private build program missing: bin/sh'):
                self.producer.required_build_inputs(pathlib.Path(directory), 'x86_64')

    def test_required_program_preflight_refuses_escaping_interpreter_without_execution(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            root = pathlib.Path(directory)
            (root / 'bin').mkdir()
            (root / 'bin/sh').symlink_to(pathlib.Path(__file__).resolve())
            with self.assertRaisesRegex(ValueError, 'required private build program escaped'):
                self.producer.required_build_inputs(root, 'x86_64')

    def test_every_provision_apt_query_selects_private_startup(self):
        # Structural caller-boundary regression complements the real apt-config
        # startup test; it is not a package/build/signature/runtime receipt.
        module = ast.parse((ROOT / ".github/scripts/prepare-qemu-gssapi-fixture.py").read_text())
        provision = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == "provision")
        queries = [node for node in ast.walk(provision) if isinstance(node, ast.Call)
                   and isinstance(node.func, ast.Name) and node.func.id == "call"
                   and node.args and isinstance(node.args[0], ast.List)
                   and isinstance(node.args[0].elts[0], ast.Constant)
                   and node.args[0].elts[0].value in ("apt-get", "apt-cache")]
        self.assertEqual(len(queries), 3)
        for query in queries:
            self.assertTrue(any(keyword.arg == "cwd" and isinstance(keyword.value, ast.Name)
                                and keyword.value.id == "base" for keyword in query.keywords),
                            "APT metadata query omitted its private startup root")

    def test_apt_without_explicit_private_startup_is_refused_before_invocation(self):
        with self.assertRaisesRegex(ValueError, "private APT startup"):
            self.producer.call(["apt-cache", "policy"])

    def test_public_failure_retains_exact_index_bytes_before_any_native_execution(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            base = pathlib.Path(directory)
            lists = base / "state/lists"
            lists.mkdir(parents=True)
            original = lists / "inert_InRelease"
            original.write_bytes(b"public storage canary; NOT signed provider metadata")
            self.producer.retain_public_inputs(base, "source-failed")
            retained = base / "public-evidence" / original.name
            self.assertEqual(retained.read_bytes(), original.read_bytes())
            self.assertTrue((base / "public-evidence/source-failed.json").is_file())

    def test_completed_provision_retains_all_declared_original_archives_as_data(self):
        # These are ordinary public IO canaries, not Debian packages, signatures
        # or provider/native acceptance. Exercise the actual retention boundary.
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            base = pathlib.Path(directory)
            cache = base / 'cache/archives'
            cache.mkdir(parents=True)
            packages = {}
            for name in ('first', 'second'):
                data = ('public archive storage canary: ' + name).encode()
                (cache / (name + '.deb')).write_bytes(data)
                digest = hashlib.sha256(data).hexdigest()
                packages[name] = {'archiveSha256': digest, 'archiveSizeBytes': len(data)}
            self.producer.retain_public_inputs(base, 'provision-complete', {'packages': packages})
            evidence = base / 'public-evidence'
            record = json.loads((evidence / 'provision-complete.json').read_text())
            self.assertEqual(set(record.get('packageArchives', {})), set(packages))
            for name, row in packages.items():
                retained = evidence / 'package-archives' / (row['archiveSha256'] + '.deb')
                self.assertTrue(retained.is_file() and not retained.is_symlink(), 'original archive bytes not retained')
                self.assertEqual(retained.read_bytes(), (cache / (name + '.deb')).read_bytes())
                self.assertEqual(retained.stat().st_mode & 0o777, 0o600)
            self.assertIs(record['runtimeVerified'], False)
            self.assertIs(record['attributionVerified'], False)

    def test_completed_provision_refuses_missing_extra_or_changed_archive(self):
        for condition in ('missing', 'extra', 'changed'):
            with self.subTest(condition=condition), tempfile.TemporaryDirectory(dir=self.parent) as directory:
                base = pathlib.Path(directory)
                cache = base / 'cache/archives'
                cache.mkdir(parents=True)
                data = b'public storage canary; no provider authenticity'
                digest = hashlib.sha256(data).hexdigest()
                packages = {'canary': {'archiveSha256': digest, 'archiveSizeBytes': len(data)}}
                if condition != 'missing':
                    (cache / 'canary.deb').write_bytes(data if condition != 'changed' else b'x' * len(data))
                if condition == 'extra':
                    (cache / 'unrecorded.deb').write_bytes(b'public extra archive canary')
                with self.assertRaises(ValueError):
                    self.producer.retain_public_inputs(base, 'provision-complete', {'packages': packages})
                self.assertFalse((base / 'public-evidence/provision-complete.json').exists())

    def test_completed_provision_refuses_archive_and_storage_aliases(self):
        for condition in ('archive-alias', 'storage-alias'):
            with self.subTest(condition=condition), tempfile.TemporaryDirectory(dir=self.parent) as directory:
                base = pathlib.Path(directory)
                cache = base / 'cache/archives'
                cache.mkdir(parents=True)
                original = base / 'public.canary'
                data = b'public alias storage canary; never a package'
                original.write_bytes(data)
                digest = hashlib.sha256(data).hexdigest()
                packages = {'canary': {'archiveSha256': digest, 'archiveSizeBytes': len(data)}}
                if condition == 'archive-alias':
                    (cache / 'canary.deb').symlink_to(original)
                else:
                    (cache / 'canary.deb').write_bytes(data)
                    evidence = base / 'public-evidence'
                    evidence.mkdir(mode=0o700)
                    (evidence / 'package-archives').symlink_to(cache, target_is_directory=True)
                with self.assertRaises(ValueError):
                    self.producer.retain_public_inputs(base, 'provision-complete', {'packages': packages})

    def test_original_archive_count_and_byte_budgets_are_complete_not_truncated(self):
        # Real narrow-directory boundary; only public IO data, never packages.
        for count in (200, 201):
            with self.subTest(count=count), tempfile.TemporaryDirectory(dir=self.parent) as directory:
                base = pathlib.Path(directory)
                cache = base / 'cache/archives'
                cache.mkdir(parents=True)
                (cache / 'partial').mkdir()
                (cache / 'lock').touch()
                packages = {}
                for index in range(count):
                    name = str(index)
                    data = ('public archive budget canary ' + name).encode()
                    (cache / (name + '.deb')).write_bytes(data)
                    packages[name] = {'archiveSha256': hashlib.sha256(data).hexdigest(), 'archiveSizeBytes': len(data)}
                if count == 200:
                    self.producer.retain_public_inputs(base, 'provision-complete', {'packages': packages})
                    record = json.loads((base / 'public-evidence/provision-complete.json').read_text())
                    self.assertEqual(set(record['packageArchives']), set(packages))
                    self.assertEqual(len(list((base / 'public-evidence/package-archives').iterdir())), 200)
                else:
                    with self.assertRaises(ValueError):
                        self.producer.retain_public_inputs(base, 'provision-complete', {'packages': packages})
                    self.assertFalse((base / 'public-evidence/provision-complete.json').exists())
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            base = pathlib.Path(directory)
            # Oversize declaration refuses before any archive allocation/read.
            packages = {str(index): {'archiveSha256': format(index, '064x'),
                                    'archiveSizeBytes': 128 * 1024 * 1024} for index in range(5)}
            with self.assertRaises(ValueError):
                self.producer.retain_public_inputs(base, 'provision-complete', {'packages': packages})
            self.assertFalse((base / 'public-evidence/package-archives').exists())

    def test_original_archive_size_links_and_special_nodes_refuse_without_fd_leak(self):
        for condition in ('size', 'hardlink', 'fifo', 'cache-alias'):
            with self.subTest(condition=condition), tempfile.TemporaryDirectory(dir=self.parent) as directory:
                base = pathlib.Path(directory)
                cache = base / 'cache/archives'
                cache.mkdir(parents=True)
                data = b'public archive refusal canary; never executable'
                digest = hashlib.sha256(data).hexdigest()
                packages = {'canary': {'archiveSha256': digest, 'archiveSizeBytes': len(data)}}
                if condition == 'fifo':
                    os.mkfifo(cache / 'canary.deb')
                else:
                    (cache / 'canary.deb').write_bytes(data)
                if condition == 'size':
                    packages['canary']['archiveSizeBytes'] += 1
                elif condition == 'hardlink':
                    os.link(cache / 'canary.deb', base / 'public.link')
                elif condition == 'cache-alias':
                    cache.rename(base / 'public-cache')
                    cache.symlink_to(base / 'public-cache', target_is_directory=True)
                before = len(list(pathlib.Path('/proc/self/fd').iterdir()))
                with self.assertRaises(ValueError):
                    self.producer.retain_public_inputs(base, 'provision-complete', {'packages': packages})
                self.assertEqual(len(list(pathlib.Path('/proc/self/fd').iterdir())), before)
                self.assertFalse((base / 'public-evidence/provision-complete.json').exists())

    def test_actual_pinned_release_is_admitted_without_execution(self):
        archive = ROOT / "crates/target/qemu-full-fixture-source/qemu-9.2.0.tar.xz"
        self.assertTrue(archive.is_file() and not archive.is_symlink(), "verified source prerequisite required; never silently skip it")
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            source = pathlib.Path(directory) / "qemu-9.2.0"
            epoch = self.producer.extract_source(archive, source)
            self.assertEqual(epoch, 1733874468)
            self.assertEqual(self.producer.sha(source / "ui/vnc-auth-sasl.c"), self.producer.VNC_SHA256)
            self.assertTrue((source / "python/wheels/meson-1.5.0-py3-none-any.whl").is_file())
            self.assertFalse((source / "roms/edk2/EmulatorPkg/Unix/Host/X11IncludeHack").is_symlink())

    def test_arm_layout_does_not_synthesize_absent_lib64_target(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            root = pathlib.Path(directory)
            for name in ('bin', 'sbin', 'lib'):
                (root / 'usr' / name).mkdir(parents=True)
            layout = self.producer.usrmerge_layout(root, 'arm64')
            self.assertFalse((root / 'lib64').is_symlink())
            self.assertNotIn('lib64', layout)
            self.producer.inventory(root)

    def test_x86_layout_requires_real_private_lib64_target(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            root = pathlib.Path(directory)
            for name in ('bin', 'sbin', 'lib'):
                (root / 'usr' / name).mkdir(parents=True)
            with self.assertRaisesRegex(ValueError, 'required private usrmerge target'):
                self.producer.usrmerge_layout(root, 'amd64')
            (root / 'usr/lib64').mkdir()
            layout = self.producer.usrmerge_layout(root, 'amd64')
            self.assertEqual(layout['lib64'], 'usr/lib64')
            self.assertEqual((root / 'lib64').resolve(strict=True), root / 'usr/lib64')
            self.producer.inventory(root)

    def test_layout_refuses_escaping_or_preexisting_wrong_alias(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            root = pathlib.Path(directory)
            for name in ('bin', 'sbin', 'lib', 'lib64'):
                (root / 'usr' / name).mkdir(parents=True)
            (root / 'bin').symlink_to('usr/lib')
            with self.assertRaisesRegex(ValueError, 'private usrmerge alias'):
                self.producer.usrmerge_layout(root, 'amd64')
            (root / 'bin').unlink()
            (root / 'usr/lib64').rmdir()
            (root / 'usr/lib64').symlink_to(self.parent)
            with self.assertRaisesRegex(ValueError, 'private usrmerge target'):
                self.producer.usrmerge_layout(root, 'amd64')

    def test_post_build_inventory_failure_is_inside_public_evidence_guard(self):
        module = ast.parse((ROOT / '.github/scripts/prepare-qemu-gssapi-fixture.py').read_text())
        main = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == 'main')
        guarded = next(node for node in main.body if isinstance(node, ast.Try))
        calls = {node.func.id for item in guarded.body for node in ast.walk(item)
                 if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)}
        self.assertIn('inventory', calls)
        constants = {node.value for item in guarded.body for node in ast.walk(item)
                     if isinstance(node, ast.Constant) and isinstance(node.value, str)}
        self.assertIn('inventory', constants)
        self.assertIn('provider', constants)

    def test_source_and_bios_inputs_are_fixed_not_host_fallbacks(self):
        self.assertEqual(self.producer.QEMU_SHA256, "f859f0bc65e1f533d040bbe8c92bcfecee5af2c921a6687c652fb44d089bd894")
        self.assertEqual(self.producer.VNC_SHA256, "3dfd2c4be76597983641fde3d99b64ac5b0d6a56b59e4d6a08edacc95075bc2d")
        self.assertEqual(set(self.producer.FIRMWARE), {"bios-256k.bin", "vgabios-stdvga.bin"})
        self.assertIn("--disable-download", self.producer.CONFIGURE)
        self.assertIn("--disable-modules", self.producer.CONFIGURE)


if __name__ == "__main__":
    unittest.main()
