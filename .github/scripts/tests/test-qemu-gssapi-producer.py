#!/usr/bin/env python3
"""Public inert input tests; no QEMU/helper/signature/runtime is impersonated."""
import hashlib
import importlib.util
import pathlib
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

    def test_source_and_bios_inputs_are_fixed_not_host_fallbacks(self):
        self.assertEqual(self.producer.QEMU_SHA256, "f859f0bc65e1f533d040bbe8c92bcfecee5af2c921a6687c652fb44d089bd894")
        self.assertEqual(self.producer.VNC_SHA256, "3dfd2c4be76597983641fde3d99b64ac5b0d6a56b59e4d6a08edacc95075bc2d")
        self.assertEqual(set(self.producer.FIRMWARE), {"bios-256k.bin", "vgabios-stdvga.bin"})
        self.assertIn("--disable-download", self.producer.CONFIGURE)
        self.assertIn("--disable-modules", self.producer.CONFIGURE)


if __name__ == "__main__":
    unittest.main()
