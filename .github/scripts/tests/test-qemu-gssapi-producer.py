#!/usr/bin/env python3
"""Public inert input tests; no QEMU/helper/signature/runtime is impersonated."""
import ast
import hashlib
import importlib.util
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
            files, aliases = self.producer.inventory(root)
            self.assertEqual(files, {"public.canary": hashlib.sha256(data).hexdigest()})
            self.assertEqual(aliases, {"alias": "public.canary"})

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

    def test_source_and_bios_inputs_are_fixed_not_host_fallbacks(self):
        self.assertEqual(self.producer.QEMU_SHA256, "f859f0bc65e1f533d040bbe8c92bcfecee5af2c921a6687c652fb44d089bd894")
        self.assertEqual(self.producer.VNC_SHA256, "3dfd2c4be76597983641fde3d99b64ac5b0d6a56b59e4d6a08edacc95075bc2d")
        self.assertEqual(set(self.producer.FIRMWARE), {"bios-256k.bin", "vgabios-stdvga.bin"})
        self.assertIn("--disable-download", self.producer.CONFIGURE)
        self.assertIn("--disable-modules", self.producer.CONFIGURE)


if __name__ == "__main__":
    unittest.main()
