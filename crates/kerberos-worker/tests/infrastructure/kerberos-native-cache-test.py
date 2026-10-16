"""Exercise the real cache/lock/filesystem with small external build fixtures."""

import fcntl
import hashlib
import io
import os
from pathlib import Path
import select
import shlex
import signal
import shutil
import subprocess
import tarfile
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[4]
RECIPE = ROOT / "crates/kerberos-worker/native/build-dependencies.sh"
LIBRARIES = ["gssapi_krb5", "krb5", "k5crypto", "com_err", "krb5support"]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class CacheTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.cache = self.root / "cache"
        self.recipe = self.root / "build-dependencies.sh"
        self.count = 0
        # Fixture upstream pins and external curl/make replace network/compiler
        # cost. Hash validation, tar IO, completion publication and flock are real.
        self.archive("zig.tar.xz", "w:xz", {"zig-x86_64-linux-0.15.2/zig": b"fixture SDK"})
        configure = ("#!/bin/sh\nset -e\n"
                     f"CACHE_TEST_ROOT={shlex.quote(str(self.root))}\n"
                     'if [ -n "${CONFIG_SITE:-}" ]; then . "$CONFIG_SITE"; fi\n'
                     'env > configure.env\nmkdir -p include\n'
                     'if [ "${ac_cv_func_getentropy:-yes}" = yes ]; then\n'
                     '  echo "#define HAVE_GETENTROPY 1" > include/autoconf.h\n'
                     'else echo "/* #undef HAVE_GETENTROPY */" > include/autoconf.h; fi\n')
        self.archive("krb5.tar.gz", "w:gz", {"krb5-1.22.2/src/configure": configure.encode()})
        self.pin_recipe()
        self.command("curl", """#!/bin/bash
set -eu
while [[ $1 != -o ]]; do url=$1; shift; done
case "$url" in *ziglang*) name=zig.tar.xz ;; *) name=krb5.tar.gz ;; esac
cp "$CACHE_TEST_ROOT/$name" "$2"
""")
        self.command("make", f"#!/bin/bash\nfixture_root={shlex.quote(str(self.root))}\n" + """
set -eu
if [[ -f "${PWD%/build}.fixture-env" ]]; then source "${PWD%/build}.fixture-env"; fi
if [[ -f "${PWD%/dependencies/build}.fixture-env" ]]; then source "${PWD%/dependencies/build}.fixture-env"; fi
env > make.env
echo "$*" >> "$fixture_root/makes"
if [[ $4 == util/et && -n ${CACHE_TEST_READY:-} ]]; then
  echo ready > "$CACHE_TEST_READY"
  read -r release < "$CACHE_TEST_RELEASE"
fi
mkdir -p include/krb5 include/gssapi util/profile lib
echo header > include/krb5/krb5.h
echo errors > include/com_err.h
for header in gssapi gssapi_krb5 gssapi_ext; do echo "$header" > "include/gssapi/$header.h"; done
echo profile > util/profile/profile.h
echo errors > util/profile/prof_err.h
for lib in gssapi_krb5 krb5 k5crypto com_err krb5support; do echo "$lib${CPATH:-}${C_INCLUDE_PATH:-}" > "lib/lib$lib.a"; done
if [[ ${CACHE_TEST_FAIL:-} == true ]]; then exit 23; fi
""")
        self.command("flock", """#!/bin/bash
set -eu
if [[ -n ${CACHE_TEST_LOCK_READY:-} ]]; then echo ready > "$CACHE_TEST_LOCK_READY"; fi
exec /usr/bin/flock "$@"
""")
        self.env = {**os.environ, "PATH": f"{self.bin}:{os.environ['PATH']}",
                    "KERBEROS_NATIVE_CACHE_DIR": str(self.cache), "CACHE_TEST_ROOT": str(self.root)}

    def archive(self, name, mode, files):
        with tarfile.open(self.root / name, mode) as archive:
            for name, data in files.items():
                info = tarfile.TarInfo(name)
                info.size, info.mode = len(data), 0o755
                archive.addfile(info, io.BytesIO(data))

    def pin_recipe(self):
        text = RECIPE.read_text()
        for original, replacement in [
            ("02aa270f183da276e5b5920b1dac44a63f1a49e55050ebde3aecc9eb82f93239", sha(self.root / "zig.tar.xz")),
            ("958ed7d1e00d0ea76590d27666efbf7a932281b3d7ba0c6b01b0ff26498f667f", sha(self.root / "zig.tar.xz")),
            ("3243ffbc8ea4d4ac22ddc7dd2a1dc54c57874c40648b60ff97009763554eaf13", sha(self.root / "krb5.tar.gz")),
        ]:
            text = text.replace(original, replacement)
        self.recipe.write_text(text)

    def command(self, name, body):
        path = self.bin / name
        path.write_text(body)
        path.chmod(0o755)

    def start(self, arch="x86_64", extra=None):
        self.count += 1
        output = self.root / f"context-{self.count}"
        # External make owns its controls outside the production environment.
        controls = {key: value for key, value in (extra or {}).items()
                    if key in {"CACHE_TEST_READY", "CACHE_TEST_RELEASE", "CACHE_TEST_FAIL",
                               "CACHE_TEST_COMPILE_FAIL"}}
        (self.root / f"context-{self.count}.fixture-env").write_text(
            "".join(f"{key}={shlex.quote(str(value))}\n" for key, value in controls.items()))
        process = subprocess.Popen(["bash", str(getattr(self, "entrypoint", self.recipe)), str(output), arch],
                                   env={**self.env, **(extra or {})}, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, text=True, start_new_session=True)
        self.addCleanup(self.stop, process)
        return process, output

    @staticmethod
    def stop(process):
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
        process.communicate(timeout=15)

    def run_build(self, hit, arch="x86_64", extra=None):
        process, output = self.start(arch, extra)
        log, _ = process.communicate(timeout=15)
        self.assertEqual(process.returncode, 0, log)
        self.assertIn(f"hit={str(hit).lower()}", log)
        for library in LIBRARIES:
            self.assertEqual((output / f"build/lib/lib{library}.a").read_text().strip(), library)
        return next(path for path in self.cache.iterdir() if path.is_dir() and path.name in log)

    def fifo(self, name):
        path = self.root / name
        os.mkfifo(path)
        fd = os.open(path, os.O_RDWR | os.O_NONBLOCK)
        self.addCleanup(os.close, fd)
        return str(path), fd

    def ready(self, fd):
        self.assertTrue(select.select([fd], [], [], 15)[0], "fixture never reached synchronization point")
        self.assertEqual(os.read(fd, 100), b"ready\n")

    def test_two_contexts_and_restored_package(self):
        entry = self.run_build(False)
        self.run_build(True)
        # Copy through a real archive, matching how CI transports cached files.
        with tarfile.open(self.root / "restore.tar", "w") as archive:
            archive.add(self.cache, arcname="cache")
        restored = self.root / "restored"
        restored.mkdir()
        with tarfile.open(self.root / "restore.tar") as archive:
            for member in archive.getmembers():
                path = Path(member.name)
                self.assertFalse(path.is_absolute())
                self.assertNotIn("..", path.parts)
                self.assertEqual(path.parts[0], "cache")
                destination = restored / path
                if member.isdir():
                    destination.mkdir(parents=True, exist_ok=True)
                else:
                    self.assertTrue(member.isfile())
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with archive.extractfile(member) as source:
                        destination.write_bytes(source.read())
        self.cache = restored / "cache"
        self.env["KERBEROS_NATIVE_CACHE_DIR"] = str(self.cache)
        self.run_build(True)
        self.assertEqual(len((self.root / "makes").read_text().splitlines()), 7)
        self.assertTrue((entry / "complete").is_file())

    def test_corrupt_incomplete_and_mismatched_products_rebuild(self):
        entry = self.run_build(False)
        for name, data in [("libraries.tar.gz", b"broken"), ("complete", b"wrong identity"),
                           ("zig.tar.xz", b"bad pin"), ("krb5.tar.gz", b"bad pin")]:
            (entry / name).write_bytes(data)
            self.run_build(name in {"zig.tar.xz", "krb5.tar.gz"})
        (entry / "complete").unlink()
        self.run_build(False)
        self.run_build(True)

    def test_unsafe_archive_is_rejected_even_with_matching_receipt(self):
        entry = self.run_build(False)
        for symlink in (False, True):
            with tarfile.open(entry / "libraries.tar.gz", "w:gz") as archive:
                info = tarfile.TarInfo("lib/libkrb5.a" if symlink else "../escaped")
                if symlink:
                    info.type, info.linkname = tarfile.SYMTYPE, str(self.root / "escaped")
                    archive.addfile(info)
                else:
                    info.size = 3
                    archive.addfile(info, io.BytesIO(b"bad"))
            (entry / "complete").write_text(f"{entry.name} {sha(entry / 'libraries.tar.gz')}\n")
            self.run_build(False)
            self.assertFalse(any(self.root.rglob("escaped")))

    def test_recipe_source_pin_and_target_invalidation(self):
        keys = {self.run_build(False).name}
        self.recipe.write_text(self.recipe.read_text().replace("CFLAGS=-O2", "CFLAGS=-O3"))
        keys.add(self.run_build(False).name)
        self.archive("krb5.tar.gz", "w:gz", {"krb5-1.22.2/src/configure": b"#!/bin/sh\n# new pin\nexit 0\n"})
        self.pin_recipe()
        keys.add(self.run_build(False).name)
        keys.add(self.run_build(False, "aarch64").name)
        self.archive("zig.tar.xz", "w:xz", {"zig-x86_64-linux-0.15.2/zig": b"new SDK pin"})
        self.pin_recipe()
        keys.add(self.run_build(False).name)
        self.command("uname", "#!/bin/sh\necho aarch64\n")
        keys.add(self.run_build(False, "aarch64").name)
        self.assertEqual(len(keys), 6)

    def test_partial_products_and_directory_substitutes_rebuild(self):
        entry = self.run_build(False)
        valid_package = (entry / "libraries.tar.gz").read_bytes()
        for directory in (False, True):
            with tarfile.open(fileobj=io.BytesIO(valid_package)) as original, \
                    tarfile.open(entry / "libraries.tar.gz", "w:gz") as archive:
                for info in original.getmembers():
                    if not directory and info.name == "lib/libkrb5.a":
                        continue
                    if directory and info.name == "include/krb5/krb5.h":
                        info.type, info.size = tarfile.DIRTYPE, 0
                        archive.addfile(info)
                    else:
                        with original.extractfile(info) as source:
                            archive.addfile(info, source)
            (entry / "complete").write_text(f"{entry.name} {sha(entry / 'libraries.tar.gz')}\n")
            self.run_build(False)

    def test_symlinked_cache_root_is_refused(self):
        other = self.root / "other"
        other.mkdir()
        self.cache.symlink_to(other, target_is_directory=True)
        process, _ = self.start()
        log, _ = process.communicate(timeout=15)
        self.assertNotEqual(process.returncode, 0, log)
        self.assertEqual(list(other.iterdir()), [])

    def test_missing_consumer_headers_rebuild(self):
        entry = self.run_build(False)
        for header in ("include/com_err.h", "include/gssapi/gssapi.h",
                       "include/gssapi/gssapi_krb5.h", "include/gssapi/gssapi_ext.h"):
            valid_package = (entry / "libraries.tar.gz").read_bytes()
            with tarfile.open(fileobj=io.BytesIO(valid_package)) as original, \
                    tarfile.open(entry / "libraries.tar.gz", "w:gz") as archive:
                for info in original.getmembers():
                    if info.name == header:
                        continue
                    with original.extractfile(info) as source:
                        archive.addfile(info, source)
            (entry / "complete").write_text(f"{entry.name} {sha(entry / 'libraries.tar.gz')}\n")
            self.run_build(False)
            with tarfile.open(entry / "libraries.tar.gz") as archive:
                with archive.extractfile(header) as restored:
                    self.assertTrue(restored.read())
        self.run_build(True)

    def test_incidental_include_overrides_do_not_poison_pinned_products(self):
        self.run_build(False, extra={"CPATH": "unrelated", "C_INCLUDE_PATH": "unrelated"})
        self.run_build(True, extra={"CPATH": "different", "C_INCLUDE_PATH": "different"})

    def test_build_environment_change_does_not_reuse_previous_products(self):
        first = self.run_build(False, extra={"KERBEROS_NATIVE_BUILD_ENV": "image-v1"})
        second = self.run_build(False, extra={"KERBEROS_NATIVE_BUILD_ENV": "image-v2"})
        self.assertNotEqual(first.name, second.name)
        self.assertEqual(self.run_build(True, extra={"KERBEROS_NATIVE_BUILD_ENV": "image-v1"}), first)

    def test_external_configure_site_is_not_executed(self):
        site = self.root / "external-config.site"
        marker = self.root / "external-site-was-executed"
        site.write_text('touch "$CACHE_TEST_ROOT/external-site-was-executed"\n')
        self.run_build(False, extra={"CONFIG_SITE": str(site)})
        self.assertFalse(marker.exists())
        self.run_build(True, extra={"CONFIG_SITE": str(site)})
        self.assertFalse(marker.exists())

    def test_external_configure_overrides_do_not_poison_products(self):
        overrides = {"ac_cv_func_getentropy": "no", "krb5_cv_attr_constructor_destructor": "no,no",
                     "ax_cv_check_cflags___Werror": "no", "k5_cv_attr_constructor_destructor": "no,no",
                     "pkg_cv_COM_ERR_LIBS": "foreign", "LIBS": "-lforeign", "DEFCCNAME": "foreign",
                     "with_crypto_impl": "foreign", "MAKEFILES": "foreign", "GNUMAKEFLAGS": "-e"}
        entry = self.run_build(False, extra=overrides)
        with tarfile.open(entry / "libraries.tar.gz") as archive:
            with archive.extractfile("include/autoconf.h") as header:
                self.assertEqual(header.read(), b"#define HAVE_GETENTROPY 1\n")
        for name in ("configure.env", "make.env"):
            observed = dict(line.split("=", 1) for line in
                            (self.root / "context-1/build" / name).read_text().splitlines())
            self.assertTrue(overrides.keys().isdisjoint(observed), sorted(overrides.keys() & observed.keys()))
        self.assertEqual(self.run_build(True), entry)

    def test_failed_build_never_publishes_completion(self):
        process, _ = self.start(extra={"CACHE_TEST_FAIL": "true"})
        log, _ = process.communicate(timeout=15)
        self.assertEqual(process.returncode, 23, log)
        self.assertFalse(list(self.cache.glob("*/complete")))
        self.run_build(False)
        self.run_build(True)

    def test_failed_header_enumeration_never_publishes_completion(self):
        self.command("find", """#!/bin/bash
/usr/bin/find "$@" | awk 'index($0, "include/gssapi/") != 1'
exit 73
""")
        process, _ = self.start()
        log, _ = process.communicate(timeout=15)
        self.assertEqual(process.returncode, 73, log)
        self.assertFalse(list(self.cache.glob("*/complete")))
        self.assertFalse(list(self.cache.glob("*/libraries.tar.gz")))
        self.command("find", '#!/bin/bash\nexec /usr/bin/find "$@"\n')
        self.run_build(False)
        self.run_build(True)

    def test_concurrent_writers_and_killed_writer_recovery(self):
        ready, ready_fd = self.fifo("ready")
        release, release_fd = self.fifo("release")
        first, _ = self.start(extra={"CACHE_TEST_READY": ready, "CACHE_TEST_RELEASE": release})
        self.ready(ready_fd)
        lock_ready, lock_fd = self.fifo("lock-ready")
        second, _ = self.start(extra={"CACHE_TEST_LOCK_READY": lock_ready})
        self.ready(lock_fd)
        lock = next(self.cache.glob("*.lock"))
        with lock.open("r") as file:
            with self.assertRaises(BlockingIOError):
                fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.assertFalse(list(self.cache.glob("*/complete")))
        os.write(release_fd, b"continue\n")
        first_log, _ = first.communicate(timeout=15)
        second_log, _ = second.communicate(timeout=15)
        self.assertEqual((first.returncode, second.returncode), (0, 0), first_log + second_log)
        self.assertIn("hit=false", first_log)
        self.assertIn("hit=true", second_log)
        self.assertEqual(len((self.root / "makes").read_text().splitlines()), 7)
        next(self.cache.glob("*/complete")).unlink()
        killed, _ = self.start(extra={"CACHE_TEST_READY": ready, "CACHE_TEST_RELEASE": release})
        self.ready(ready_fd)
        self.stop(killed)
        self.run_build(False)

    def helper_fixture(self):
        # Exercise the unmodified final-product recipe with the existing tiny
        # upstream fixtures. The external compiler emits actual ELF files; real
        # Kerberos compilation and execution remain the native CI matrix's job.
        self.native = self.root / "native"
        shutil.copytree(RECIPE.parent, self.native)
        binary = self.root / "fixture-helper"
        subprocess.run(["cc", "-static", "-x", "c", "-o", str(binary), "-"],
                       input=b"int main(void) { return 0; }\n", check=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        zig = f"#!/bin/bash\nfixture_root={shlex.quote(str(self.root))}\n" + """
set -eu
context=$(cd -- "$(dirname -- "$0")/../.." && pwd -P)
source "$context.fixture-env"
env > "$fixture_root/compiler.env"
if [[ ${CACHE_TEST_COMPILE_FAIL:-} == true ]]; then exit 24; fi
echo compile >> "$fixture_root/compiles"
while [[ $1 != -o ]]; do shift; done
cp "$fixture_root/fixture-helper" "$2"
"""
        sdk = {}
        for host in ("x86_64", "aarch64"):
            prefix = f"zig-{host}-linux-0.15.2"
            sdk[f"{prefix}/zig"] = zig.encode()
            sdk[f"{prefix}/LICENSE"] = (self.native / "NOTICE-Zig").read_bytes()
            sdk[f"{prefix}/lib/libc/musl/COPYRIGHT"] = (self.native / "NOTICE-musl").read_bytes()
        self.archive("zig.tar.xz", "w:xz", sdk)
        with tarfile.open(self.root / "krb5.tar.gz") as archive:
            with archive.extractfile("krb5-1.22.2/src/configure") as source:
                configure = source.read()
        self.archive("krb5.tar.gz", "w:gz", {
            "krb5-1.22.2/src/configure": configure,
            "krb5-1.22.2/NOTICE": (self.native / "NOTICE-MIT").read_bytes(),
        })
        self.pin_recipe()
        shutil.copyfile(self.recipe, self.native / "build-dependencies.sh")
        self.entrypoint = self.native / "build.sh"

    def run_helper(self, hit, extra=None):
        process, output = self.start(extra=extra)
        log, _ = process.communicate(timeout=15)
        self.assertEqual(process.returncode, 0, log)
        self.assertIn(f"native package: hit={str(hit).lower()}", log)
        self.assertEqual((output / "kerberos-worker").read_bytes(),
                         (self.root / "fixture-helper").read_bytes())
        if hit:
            self.assertFalse((output / "dependencies").exists())
        entry = next(path for path in self.cache.glob("helper-*") if path.is_dir() and path.name[7:] in log)
        return entry

    @staticmethod
    def helper_receipt(entry):
        names = ("kerberos-worker", "NOTICE-MIT", "NOTICE-musl", "NOTICE-Zig")
        (entry / "complete").write_text(entry.name[7:] + "\n" + "".join(
            f"{sha(entry / name)}  {name}\n" for name in names))

    def test_helper_cross_output_and_transported_hit_avoids_native_work(self):
        self.helper_fixture()
        self.run_helper(False)
        restored = self.root / "restored-cache"
        shutil.copytree(self.cache, restored)
        self.cache = restored
        self.env["KERBEROS_NATIVE_CACHE_DIR"] = str(restored)
        self.command("curl", "#!/bin/sh\nexit 87\n")
        self.command("make", "#!/bin/sh\nexit 88\n")
        self.run_helper(True)
        self.assertEqual((self.root / "compiles").read_text(), "compile\n")

    def test_helper_source_recipe_notice_and_environment_invalidation(self):
        self.helper_fixture()
        keys = {self.run_helper(False).name}
        for name in ("worker.c", "isolation.h", "build.sh", "build-dependencies.sh"):
            path = self.native / name
            with path.open("a") as file:
                file.write("\n" if path.suffix == ".sh" else "\n/* changed native input */\n")
            keys.add(self.run_helper(False).name)
        keys.add(self.run_helper(False, extra={"KERBEROS_NATIVE_BUILD_ENV": "other-image"}).name)
        self.assertEqual(len(keys), 6)
        for name in ("NOTICE-MIT", "NOTICE-musl", "NOTICE-Zig"):
            original = (self.native / name).read_bytes()
            (self.native / name).write_bytes(original + b"changed notice\n")
            process, _ = self.start()
            log, _ = process.communicate(timeout=15)
            self.assertNotEqual(process.returncode, 0, log)
            self.assertNotIn("native package: hit=true", log)
            (self.native / name).write_bytes(original)
        self.run_helper(True)

    def test_helper_rejects_corrupt_partial_and_unsafe_products(self):
        self.helper_fixture()
        entry = self.run_helper(False)
        lock = entry.with_suffix(".lock")
        inode = lock.stat().st_ino
        for kind in ("digest", "receipt", "missing", "symlink", "hardlink", "directory",
                     "notice", "architecture", "dynamic", "relocatable", "oversize"):
            with self.subTest(kind=kind):
                helper = entry / "kerberos-worker"
                if kind == "digest":
                    data = bytearray(helper.read_bytes()); data[-1] ^= 1; helper.write_bytes(data)
                elif kind == "receipt":
                    (entry / "complete").write_text("stale identity\n")
                elif kind == "missing":
                    (entry / "NOTICE-Zig").unlink()
                elif kind in {"symlink", "hardlink", "directory"}:
                    helper.unlink()
                    if kind == "symlink": helper.symlink_to(self.root / "fixture-helper")
                    elif kind == "hardlink": os.link(self.root / "fixture-helper", helper)
                    else: helper.mkdir()
                elif kind == "notice":
                    (entry / "NOTICE-MIT").write_text("wrong license")
                    self.helper_receipt(entry)
                elif kind == "architecture":
                    data = bytearray(helper.read_bytes()); data[18:20] = (183).to_bytes(2, "little")
                    helper.write_bytes(data); self.helper_receipt(entry)
                elif kind in {"dynamic", "relocatable"}:
                    subprocess.run(["cc", *(["-c"] if kind == "relocatable" else []),
                                    "-x", "c", "-o", str(helper), "-"],
                                   input=b"int main(void) { return 0; }\n", check=True)
                    self.helper_receipt(entry)
                else:
                    with helper.open("r+b") as file: file.truncate(16777217)
                    self.helper_receipt(entry)
                self.run_helper(False)
                self.assertEqual(lock.stat().st_ino, inode)
        self.run_helper(True)

    def test_helper_compile_failure_and_ambient_options(self):
        self.helper_fixture()
        process, _ = self.start(extra={"CACHE_TEST_COMPILE_FAIL": "true"})
        log, _ = process.communicate(timeout=15)
        self.assertEqual(process.returncode, 24, log)
        self.assertFalse(list(self.cache.glob("helper-*/complete")))
        self.run_helper(False, extra={"CPATH": "foreign", "ZIG_LIB_DIR": "foreign",
                                      "SOURCE_DATE_EPOCH": "1", "CFLAGS": "foreign"})
        observed = dict(line.split("=", 1) for line in (self.root / "compiler.env").read_text().splitlines())
        self.assertTrue({"CPATH", "ZIG_LIB_DIR", "SOURCE_DATE_EPOCH", "CFLAGS"}.isdisjoint(observed))
        self.run_helper(True)

    def test_helper_host_and_target_identity(self):
        self.helper_fixture()
        first = self.run_helper(False)
        process, _ = self.start(arch="aarch64")
        log, _ = process.communicate(timeout=15)
        # The external fixture still emits x86 ELF: a target change must miss
        # and fail architecture validation, never accept the old x86 helper.
        self.assertNotEqual(process.returncode, 0, log)
        self.assertNotIn("native package: hit=true", log)
        self.command("uname", "#!/bin/sh\necho aarch64\n")
        second = self.run_helper(False)
        self.assertNotEqual(first, second)
        self.run_helper(True)

    def test_helper_entry_and_lock_symlinks_are_refused(self):
        self.helper_fixture()
        entry = self.run_helper(False)
        other = self.root / "outside"
        entry.rename(other)
        entry.symlink_to(other, target_is_directory=True)
        process, _ = self.start()
        log, _ = process.communicate(timeout=15)
        self.assertNotEqual(process.returncode, 0, log)
        entry.unlink()
        other.rename(entry)
        lock = entry.with_suffix(".lock")
        lock.unlink()
        outside = self.root / "outside-lock"
        outside.write_text("unchanged")
        lock.symlink_to(outside)
        process, _ = self.start()
        log, _ = process.communicate(timeout=15)
        self.assertNotEqual(process.returncode, 0, log)
        self.assertEqual(outside.read_text(), "unchanged")

    def test_helper_concurrent_and_interrupted_owners(self):
        self.helper_fixture()
        ready, ready_fd = self.fifo("helper-ready")
        release, release_fd = self.fifo("helper-release")
        first, _ = self.start(extra={"CACHE_TEST_READY": ready, "CACHE_TEST_RELEASE": release})
        self.ready(ready_fd)
        lock_ready, lock_fd = self.fifo("helper-lock-ready")
        second, _ = self.start(extra={"CACHE_TEST_LOCK_READY": lock_ready})
        self.ready(lock_fd)
        lock = next(self.cache.glob("helper-*.lock"))
        with lock.open("r") as file:
            with self.assertRaises(BlockingIOError): fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.assertFalse(list(self.cache.glob("helper-*/complete")))
        os.write(release_fd, b"continue\n")
        first_log, _ = first.communicate(timeout=15)
        second_log, _ = second.communicate(timeout=15)
        self.assertEqual((first.returncode, second.returncode), (0, 0), first_log + second_log)
        self.assertIn("native package: hit=false", first_log)
        self.assertIn("native package: hit=true", second_log)
        self.assertEqual((self.root / "compiles").read_text(), "compile\n")
        next(self.cache.glob("helper-*/complete")).unlink()
        self.command("cp", """#!/bin/bash
set -eu
/bin/cp "$@"
if [[ ${@: -1} == */helper-*/kerberos-worker.part ]]; then
  echo ready > "$CACHE_TEST_PUBLISH_READY"
  read -r release < "$CACHE_TEST_PUBLISH_RELEASE"
fi
""")
        killed, _ = self.start(extra={"CACHE_TEST_PUBLISH_READY": ready,
                                    "CACHE_TEST_PUBLISH_RELEASE": release})
        self.ready(ready_fd)
        self.stop(killed)
        self.assertFalse(list(self.cache.glob("helper-*/complete")))
        self.command("cp", '#!/bin/bash\nexec /bin/cp "$@"\n')
        self.run_helper(False)
        self.run_helper(True)


if __name__ == "__main__":
    unittest.main()
