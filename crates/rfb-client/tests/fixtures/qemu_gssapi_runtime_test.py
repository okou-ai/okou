#!/usr/bin/env python3
"""Byte-integrity tests for fixture inputs, not Kerberos/QEMU runtime coverage.

All file contents below are public inert canaries. Nothing is executed or loaded;
no backend, native result, credential, signed archive or runtime receipt is faked.
"""
import hashlib
import json
import pathlib
import platform
import subprocess
import sys
import tempfile
import unittest

import qemu_gssapi


class RuntimeInputs(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.parent = qemu_gssapi.REPO / "crates/target/qemu-gssapi-runtime-tests"
        cls.parent.mkdir(parents=True, exist_ok=True)
        if cls.parent.is_symlink() or cls.parent.resolve() != cls.parent:
            raise RuntimeError("unsafe fixture-test directory")

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=self.parent)
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.runtime = self.root / "runtime"
        self.runtime.mkdir(mode=0o700)

    def inputs(self, multiarch="x86_64-linux-gnu", full_qemu=False):
        files = {}
        libraries = ("libgssapi_krb5.so.2", "libkrb5.so.3", "libk5crypto.so.3", "libkrb5support.so.0")
        if full_qemu:
            libraries += ("libsasl2.so.2", "sasl2/libgssapiv2.so.2", "libgnutls.so.30")
        for name in libraries:
            alias = self.runtime / "usr/lib" / multiarch / name
            actual = alias.with_name(alias.name + ".canary")
            actual.parent.mkdir(parents=True, exist_ok=True)
            actual.write_bytes(b"inert integrity canary: " + name.encode())
            alias.symlink_to(actual.name)
            files[str(actual.relative_to(self.runtime))] = hashlib.sha256(actual.read_bytes()).hexdigest()
        tools = ("usr/sbin/kdb5_util", "usr/sbin/kadmin.local", "usr/sbin/krb5kdc",
                 "usr/bin/kinit.mit", "usr/bin/kvno", "usr/bin/klist.mit")
        if full_qemu:
            tools += ("usr/share/seabios/bios.bin", "usr/share/seabios/vgabios-stdvga.bin")
        for name in tools:
            path = self.runtime / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"inert nonexecutable input canary: " + name.encode())
            files[name] = hashlib.sha256(path.read_bytes()).hexdigest()
        architecture = {"x86_64-linux-gnu": "amd64", "aarch64-linux-gnu": "arm64"}[multiarch]
        packages = {name: {"version": "1.20.1-6ubuntu2", "architecture": architecture} for name in (
            "libgssapi-krb5-2", "libkrb5-3", "libk5crypto3", "libkrb5support0",
            "krb5-user", "krb5-kdc", "krb5-admin-server")}
        if full_qemu:
            packages.update({name: {"version": "2.1.28+dfsg1-5ubuntu3", "architecture": architecture} for name in (
                "libsasl2-2", "libsasl2-modules-gssapi-mit")})
            packages["libgnutls30t64"] = {"version": "3.8.3-1.1ubuntu3.6", "architecture": architecture}
        baseline = {"mitVersion": "1.20.1-6ubuntu2", "multiarch": multiarch,
                    "architecture": architecture, "packages": packages, "files": files}
        self.save(baseline)
        return baseline

    def save(self, baseline):
        (self.runtime / "provider.json").write_text(json.dumps(baseline))

    def verify(self, full_qemu=False, multiarch="x86_64-linux-gnu"):
        qemu_gssapi.verify_runtime(self.runtime, multiarch, full_qemu)

    def test_valid_integrity_records_for_both_modes_and_architectures(self):
        for multiarch in ("x86_64-linux-gnu", "aarch64-linux-gnu"):
            for full_qemu in (False, True):
                with self.subTest(multiarch=multiarch, full_qemu=full_qemu):
                    self.runtime = self.root / (multiarch + str(full_qemu))
                    self.runtime.mkdir(mode=0o700)
                    self.inputs(multiarch, full_qemu)
                    self.verify(full_qemu, multiarch)

    def test_manifest_architecture_must_match_selected_layout(self):
        for multiarch, wrong in (("x86_64-linux-gnu", "arm64"), ("aarch64-linux-gnu", "amd64")):
            for full_qemu in (False, True):
                with self.subTest(multiarch=multiarch, full_qemu=full_qemu):
                    self.runtime = self.root / (multiarch + str(full_qemu))
                    self.runtime.mkdir(mode=0o700)
                    baseline = self.inputs(multiarch, full_qemu)
                    baseline["architecture"] = wrong
                    self.save(baseline)
                    with self.assertRaises(ValueError):
                        self.verify(full_qemu, multiarch)

    def test_required_native_package_architecture_must_match_selected_layout(self):
        for multiarch, wrong in (("x86_64-linux-gnu", "arm64"), ("aarch64-linux-gnu", "amd64")):
            for full_qemu in (False, True):
                self.runtime = self.root / (multiarch + str(full_qemu))
                self.runtime.mkdir(mode=0o700)
                baseline = self.inputs(multiarch, full_qemu)
                for name in baseline["packages"]:
                    with self.subTest(multiarch=multiarch, full_qemu=full_qemu, package=name):
                        actual = baseline["packages"][name]["architecture"]
                        baseline["packages"][name]["architecture"] = wrong
                        self.save(baseline)
                        with self.assertRaises(ValueError):
                            self.verify(full_qemu, multiarch)
                        baseline["packages"][name]["architecture"] = actual

    def test_required_architecture_records_cannot_be_absent(self):
        baseline = self.inputs(full_qemu=True)
        del baseline["architecture"]
        self.save(baseline)
        with self.assertRaises(ValueError):
            self.verify(full_qemu=True)
        baseline["architecture"] = "amd64"
        del baseline["packages"]["libgssapi-krb5-2"]["architecture"]
        self.save(baseline)
        with self.assertRaises(ValueError):
            self.verify(full_qemu=True)

    def test_new_full_source_profile_cannot_self_admit_an_unreviewed_producer(self):
        baseline = self.inputs(full_qemu=True)
        baseline["fullQemuProvider"] = "source-pinned-private-noble-v1"
        self.save(baseline)
        # Public inert input records, not a build/runtime/signature receipt.
        with self.assertRaisesRegex(ValueError, "reviewed native producer pins"):
            qemu_gssapi.verify_runtime(self.runtime, "x86_64-linux-gnu", True, True)

    def test_full_private_inventory_binds_every_regular_file_and_alias(self):
        baseline = self.inputs(full_qemu=True)
        baseline["aliases"] = {str(path.relative_to(self.runtime)): str(path.readlink())
                               for path in self.runtime.rglob("*") if path.is_symlink()}
        self.save(baseline)
        expected = hashlib.sha256(json.dumps({name: baseline[name] for name in ("files", "aliases")},
                                            sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        self.assertEqual(qemu_gssapi.full_private_inventory(self.runtime, baseline), expected)
        # Rehashing a supplied manifest cannot hide a new unrecorded input.
        (self.runtime / "unrecorded-public.canary").write_bytes(b"public inert inventory canary")
        with self.assertRaisesRegex(ValueError, "complete input inventory"):
            qemu_gssapi.full_private_inventory(self.runtime, baseline)
        (self.runtime / "unrecorded-public.canary").unlink()
        alias = self.runtime / "extra-public.alias"
        alias.symlink_to("usr/sbin/krb5kdc")
        with self.assertRaisesRegex(ValueError, "complete input inventory"):
            qemu_gssapi.full_private_inventory(self.runtime, baseline)

    def test_full_mode_refuses_changed_private_kdc_bytes(self):
        self.inputs(full_qemu=True)
        (self.runtime / "usr/sbin/krb5kdc").write_bytes(b"changed public canary")
        with self.assertRaises(ValueError):
            self.verify(full_qemu=True)

    def test_full_mode_refuses_missing_cyrus_record(self):
        baseline = self.inputs(full_qemu=True)
        del baseline["packages"]["libsasl2-modules-gssapi-mit"]
        self.save(baseline)
        with self.assertRaises(ValueError):
            self.verify(full_qemu=True)

    def test_full_mode_refuses_wrong_gnutls_version(self):
        baseline = self.inputs(full_qemu=True)
        baseline["packages"]["libgnutls30t64"]["version"] = "unverified-version"
        self.save(baseline)
        with self.assertRaises(ValueError):
            self.verify(full_qemu=True)

    def test_full_mode_refuses_escaped_cyrus_plugin_alias(self):
        self.inputs(full_qemu=True)
        alias = self.runtime / "usr/lib/x86_64-linux-gnu/sasl2/libgssapiv2.so.2"
        alias.unlink()
        outside = self.root / "outside.canary"
        outside.write_bytes(b"public outside canary")
        alias.symlink_to(outside)
        with self.assertRaises(ValueError):
            self.verify(full_qemu=True)

    def test_missing_record_for_used_kdc_tool_is_not_verified(self):
        baseline = self.inputs()
        del baseline["files"]["usr/sbin/kdb5_util"]
        self.save(baseline)
        with self.assertRaises(ValueError):
            self.verify()

    def test_mit_version_and_architecture_must_match(self):
        baseline = self.inputs()
        baseline["packages"]["libkrb5support0"]["version"] = "unverified-version"
        self.save(baseline)
        with self.assertRaises(ValueError):
            self.verify()
        baseline["packages"]["libkrb5support0"]["version"] = "1.20.1-6ubuntu2"
        self.save(baseline)
        with self.assertRaises(ValueError):
            self.verify(multiarch="aarch64-linux-gnu")

    def test_full_cli_checks_private_digest_before_qemu_or_provisioning(self):
        multiarch = {"x86_64": "x86_64-linux-gnu", "aarch64": "aarch64-linux-gnu"}[platform.machine()]
        self.inputs(multiarch, full_qemu=True)
        (self.runtime / "usr/sbin/krb5kdc").write_bytes(b"changed public canary")
        work_root = qemu_gssapi.REPO / "codex-work/tmp/issue-37612-native-fixture"
        before = work_root.exists()
        # The secondary executable path deliberately does not exist. It is a
        # refused input, not a fake QEMU/helper; no executable can be launched.
        result = subprocess.run([sys.executable, "-B", str(pathlib.Path(qemu_gssapi.__file__)),
                                 "--runtime-dir", str(self.runtime), "--qemu", str(self.root / "absent-qemu")],
                                cwd=qemu_gssapi.REPO, capture_output=True, text=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("independent fixture file digest refused", result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertEqual(work_root.exists(), before)

    def test_full_mode_requires_a_manifest(self):
        self.inputs(full_qemu=True)
        (self.runtime / "provider.json").unlink()
        with self.assertRaises(ValueError):
            self.verify(full_qemu=True)

    def test_full_mode_requires_verified_bios_inputs(self):
        baseline = self.inputs(full_qemu=True)
        del baseline["files"]["usr/share/seabios/bios.bin"]
        self.save(baseline)
        with self.assertRaises(ValueError):
            self.verify(full_qemu=True)

    def test_manifest_file_cannot_be_a_symlink(self):
        self.inputs()
        manifest = self.runtime / "provider.json"
        outside = self.root / "outside.json"
        manifest.rename(outside)
        manifest.symlink_to(outside)
        with self.assertRaises(ValueError):
            self.verify()

    def test_manifest_paths_cannot_traverse_or_be_absolute(self):
        baseline = self.inputs()
        for name in ("../outside.canary", str(self.runtime / "usr/sbin/krb5kdc")):
            with self.subTest(name=name):
                baseline["files"][name] = hashlib.sha256(b"public canary").hexdigest()
                self.save(baseline)
                with self.assertRaises(ValueError):
                    self.verify()
                del baseline["files"][name]


if __name__ == "__main__":
    unittest.main()
