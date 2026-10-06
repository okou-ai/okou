#!/usr/bin/env python3
"""Byte-integrity tests for fixture inputs, not Kerberos/QEMU runtime coverage.

All file contents below are public inert canaries. Nothing is executed or loaded;
no backend, native result, credential, signed archive or runtime receipt is faked.
"""
import errno
import hashlib
import json
import os
import stat
import pathlib
import platform
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

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

    def full_private_inputs(self):
        baseline = self.inputs(full_qemu=True)
        baseline["aliases"] = {str(path.relative_to(self.runtime)): str(path.readlink())
                               for path in self.runtime.rglob("*") if path.is_symlink()}
        # Header-only, non-loadable public parser data; never executed, loaded
        # or admitted as a signed/native provider or completed runtime receipt.
        role = 'usr/bin/public-header.canary'
        path = self.runtime / role
        header = bytearray(64)
        header[:6] = b'\x7fELF\x02\x01'
        header[18:20] = (62).to_bytes(2, 'little')
        path.write_bytes(header)
        path.chmod(0o755)
        digest = hashlib.sha256(header).hexdigest()
        baseline['files'][role] = digest
        baseline['requiredBuildInputs'] = {role: {'file': role, 'sha256': digest, 'mode': 0o755}}
        # Complete source-built measurement has NO skipped provider path.
        # Its descriptor lives outside this public staging tree.
        (self.runtime / 'provider.json').unlink()
        baseline['immutableTree'] = qemu_gssapi.measure_immutable_tree(self.runtime)
        return baseline

    def test_full_private_inventory_refuses_actual_program_mode_mutation(self):
        baseline = self.full_private_inputs()
        program = self.runtime / 'usr/bin/public-header.canary'
        for mode in (0o644, 0o777, 0o4755):
            with self.subTest(mode=oct(mode)):
                program.chmod(mode)
                with self.assertRaisesRegex(ValueError, 'full-private executable role'):
                    qemu_gssapi.full_private_inventory(self.runtime, baseline)
                self.assertEqual(hashlib.sha256(program.read_bytes()).hexdigest(),
                                 baseline['files']['usr/bin/public-header.canary'])
        program.chmod(0o755)
        qemu_gssapi.full_private_inventory(self.runtime, baseline)

    def test_full_private_inventory_refuses_wrong_native_program_header(self):
        baseline = self.full_private_inputs()
        baseline['architecture'] = 'arm64'
        with self.assertRaisesRegex(ValueError, 'full-private executable role native'):
            qemu_gssapi.full_private_inventory(self.runtime, baseline)

    def test_full_private_program_role_refuses_escaping_path_and_changed_target(self):
        baseline = self.full_private_inputs()
        role = 'usr/bin/public-header.canary'
        record = baseline['requiredBuildInputs'][role]
        for declared in ('../outside.canary', '/outside.canary', 'usr/bin/kinit.mit'):
            with self.subTest(declared=declared):
                record['file'] = declared
                with self.assertRaisesRegex(ValueError, 'full-private executable role'):
                    qemu_gssapi.full_private_inventory(self.runtime, baseline)
        record['file'] = role
        alias = self.runtime / 'usr/bin/public-role.alias'
        alias.symlink_to('public-header.canary')
        baseline['aliases'][str(alias.relative_to(self.runtime))] = str(alias.readlink())
        baseline['requiredBuildInputs'] = {str(alias.relative_to(self.runtime)): record}
        # The positive PUBLIC parser case now declares its complete alias/node
        # tree before validation. It is not a producer pin or runtime receipt.
        baseline['immutableTree'] = qemu_gssapi.measure_immutable_tree(self.runtime)
        qemu_gssapi.full_private_inventory(self.runtime, baseline)
        alias.unlink()
        alias.symlink_to('/outside.canary')
        with self.assertRaisesRegex(ValueError, 'full-private executable role'):
            qemu_gssapi.full_private_inventory(self.runtime, baseline)

    def test_full_private_inventory_binds_every_regular_file_and_alias(self):
        baseline = self.full_private_inputs()
        expected = qemu_gssapi.immutable_tree_digest(baseline['immutableTree'])
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

    def test_complete_inventory_refuses_nonrole_chmod_without_byte_change(self):
        baseline = self.full_private_inputs()
        path = self.runtime / 'usr/sbin/kdb5_util'
        before = path.read_bytes()
        path.chmod(0o600)
        self.assertEqual(path.read_bytes(), before)
        with self.assertRaisesRegex(ValueError, 'complete input inventory'):
            qemu_gssapi.full_private_inventory(self.runtime, baseline)

    def test_complete_inventory_refuses_directory_chmod(self):
        baseline = self.full_private_inputs()
        (self.runtime / 'usr/share/seabios').chmod(0o777)
        with self.assertRaisesRegex(ValueError, 'complete input inventory'):
            qemu_gssapi.full_private_inventory(self.runtime, baseline)

    def test_complete_inventory_refuses_root_chmod(self):
        baseline = self.full_private_inputs()
        self.runtime.chmod(0o711)
        with self.assertRaisesRegex(ValueError, 'complete input inventory'):
            qemu_gssapi.full_private_inventory(self.runtime, baseline)

    def test_complete_inventory_refuses_new_empty_directory(self):
        baseline = self.full_private_inputs()
        (self.runtime / 'unrecorded-empty.canary').mkdir()
        with self.assertRaisesRegex(ValueError, 'complete input inventory'):
            qemu_gssapi.full_private_inventory(self.runtime, baseline)

    def test_complete_inventory_has_no_provider_path_omission(self):
        baseline = self.full_private_inputs()
        (self.runtime / 'provider.json').write_bytes(b'public inert non-provider data')
        with self.assertRaisesRegex(ValueError, 'complete input inventory'):
            qemu_gssapi.full_private_inventory(self.runtime, baseline)

    def test_actual_owner_mode_and_xattrs_are_bound_including_empty_sets(self):
        baseline = self.full_private_inputs()
        path = self.runtime / 'usr/sbin/kdb5_util'
        row = baseline['immutableTree']['nodes']['usr/sbin/kdb5_util']
        info = path.stat()
        self.assertEqual((row['uid'], row['gid'], row['mode']), (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)))
        self.assertEqual(set(row['xattrs']), {os.fsencode(name).hex() for name in os.listxattr(path)})
        name, data = 'user.public-canary', b'public attribute bytes'
        os.setxattr(path, name, data)
        measured = qemu_gssapi.measure_immutable_tree(self.runtime)
        self.assertEqual(measured['nodes']['usr/sbin/kdb5_util']['xattrs'][name.encode().hex()],
                         {'sizeBytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
        with self.assertRaisesRegex(ValueError, 'complete input inventory'):
            qemu_gssapi.full_private_inventory(self.runtime, baseline)
        os.removexattr(path, name)
        self.assertEqual(qemu_gssapi.measure_immutable_tree(self.runtime), baseline['immutableTree'])

    def test_hardlink_classes_bind_topology_not_inode_numbers(self):
        first, second = self.runtime / 'a.canary', self.runtime / 'b.canary'
        first.write_bytes(b'public equal bytes')
        os.link(first, second)
        original = qemu_gssapi.measure_immutable_tree(self.runtime)
        self.assertEqual(original['hardlinkGroups'], [['a.canary', 'b.canary']])
        other = self.root / 'other-public-tree'
        other.mkdir(mode=stat.S_IMODE(self.runtime.stat().st_mode))
        (other / 'a.canary').write_bytes(first.read_bytes())
        os.link(other / 'a.canary', other / 'b.canary')
        self.assertNotEqual(first.stat().st_ino, (other / 'a.canary').stat().st_ino)
        self.assertEqual(qemu_gssapi.measure_immutable_tree(other), original)
        second.unlink()
        second.write_bytes(first.read_bytes())
        self.assertNotEqual(qemu_gssapi.measure_immutable_tree(self.runtime), original)

    def test_symlink_hardlink_classes_and_actual_alias_size_are_bound(self):
        (self.runtime / 'public.canary').write_bytes(b'public alias target')
        first, second = self.runtime / 'a.alias', self.runtime / 'b.alias'
        first.symlink_to('public.canary')
        os.link(first, second, follow_symlinks=False)
        tree = qemu_gssapi.measure_immutable_tree(self.runtime)
        self.assertEqual(tree['hardlinkGroups'], [['a.alias', 'b.alias']])
        self.assertEqual(tree['nodes']['a.alias']['sizeBytes'], first.lstat().st_size)
        second.unlink()
        second.symlink_to('public.canary')
        self.assertNotEqual(qemu_gssapi.measure_immutable_tree(self.runtime), tree)
        second.unlink()
        os.link(first, self.root / 'outside.alias', follow_symlinks=False)
        with self.assertRaisesRegex(ValueError, 'external hardlink'):
            qemu_gssapi.measure_immutable_tree(self.runtime)

    def test_external_hardlink_refuses_incomplete_link_equivalence(self):
        path = self.runtime / 'a.canary'
        path.write_bytes(b'public hardlink data')
        os.link(path, self.root / 'outside.canary')
        with self.assertRaisesRegex(ValueError, 'external hardlink'):
            qemu_gssapi.measure_immutable_tree(self.runtime)

    def test_alias_loop_absolute_and_dangling_escape_are_refused(self):
        path = self.runtime / 'alias'
        for target in ('/outside.canary', 'missing/../../outside.canary'):
            path.symlink_to(target)
            with self.subTest(target=target), self.assertRaises(ValueError):
                qemu_gssapi.measure_immutable_tree(self.runtime)
            path.unlink()
        path.symlink_to('alias-loop')
        (self.runtime / 'alias-loop').symlink_to('alias')
        with self.assertRaisesRegex(ValueError, 'alias loop/depth'):
            qemu_gssapi.measure_immutable_tree(self.runtime)

    def test_dangling_alias_identity_is_data_not_broad_prefix_admission(self):
        (self.runtime / 'exact.canary').symlink_to('missing.canary')
        row = qemu_gssapi.measure_immutable_tree(self.runtime)['nodes']['exact.canary']
        self.assertEqual(row['target'], 'missing.canary')
        self.assertEqual(row['resolution'], {'kind': 'missing', 'pathHex': b'missing.canary'.hex(),
                                             'missingPrefixHex': b'missing.canary'.hex()})

    def test_byte_exact_non_utf8_paths_and_aliases_roundtrip(self):
        name = b'public-\xff.canary'
        with open(os.fsencode(self.runtime) + b'/' + name, 'wb') as stream:
            stream.write(b'public byte-encoded path data')
        os.symlink(name, os.fsencode(self.runtime) + b'/alias')
        tree = qemu_gssapi.measure_immutable_tree(self.runtime)
        self.assertEqual(tree['nodes'][os.fsdecode(name)]['pathHex'], name.hex())
        self.assertEqual(tree['nodes']['alias']['targetHex'], name.hex())
        roundtrip = json.loads(json.dumps(tree, ensure_ascii=True))
        self.assertEqual(qemu_gssapi.immutable_tree_digest(roundtrip), qemu_gssapi.immutable_tree_digest(tree))

    def test_special_node_refusal_and_exception_close_descriptors(self):
        os.mkfifo(self.runtime / 'public-fifo')
        descriptors = set(os.listdir('/proc/self/fd'))
        with self.assertRaisesRegex(ValueError, 'special input'):
            qemu_gssapi.measure_immutable_tree(self.runtime)
        self.assertEqual(set(os.listdir('/proc/self/fd')), descriptors)

    def test_directory_aggregate_name_budget_exact_limit_and_overflow(self):
        # Tighten ONLY this public data test's limits; no CLI/env override.
        # Every logical child name is charged once initially and once on rescan.
        for name in ('a', 'bb', 'ccccc'):
            (self.runtime / name).mkdir()
        with mock.patch.object(qemu_gssapi, 'IMMUTABLE_NAME_BYTE_LIMIT', 16):
            tree = qemu_gssapi.measure_immutable_tree(self.runtime)
            self.assertEqual(len(tree['nodes']), 4)
        with mock.patch.object(qemu_gssapi, 'IMMUTABLE_NAME_BYTE_LIMIT', 15):
            with self.assertRaisesRegex(ValueError, 'name byte budget'):
                qemu_gssapi.measure_immutable_tree(self.runtime)

    def test_directory_entry_overflow_refuses_before_child_descriptor_open(self):
        for name in ('a', 'b', 'c', 'd'):
            (self.runtime / name).mkdir()
        original_open = os.open
        with mock.patch.object(qemu_gssapi, 'IMMUTABLE_NODE_LIMIT', 4):
            with mock.patch.object(qemu_gssapi.os, 'open', wraps=original_open) as opens:
                with self.assertRaises(ValueError):
                    qemu_gssapi.measure_immutable_tree(self.runtime)
            # Real root FD opens, but no child is touched after enumeration
            # encounters its first excess name. Not fake native/provider IO.
            self.assertEqual(len(opens.call_args_list), 1)

    def test_directory_pending_children_reserve_global_node_budget(self):
        for name in ('a', 'b'):
            (self.runtime / name).mkdir()
            (self.runtime / name / 'child').mkdir()
        with mock.patch.object(qemu_gssapi, 'IMMUTABLE_NODE_LIMIT', 4):
            with self.assertRaisesRegex(ValueError, 'directory entry budget'):
                qemu_gssapi.measure_immutable_tree(self.runtime)

    def test_directory_rescan_applies_incremental_entry_budget(self):
        (self.runtime / 'a').mkdir()
        original_scandir, calls = os.scandir, 0
        def add_before_rescan(fd):
            nonlocal calls
            calls += 1
            # Root initial, empty child initial/rescan, root rescan.
            if calls == 4:
                (self.runtime / 'new-entry').mkdir()
            return original_scandir(fd)
        with mock.patch.object(qemu_gssapi.os, 'scandir', side_effect=add_before_rescan):
            with self.assertRaisesRegex(ValueError, 'directory entry budget'):
                qemu_gssapi.measure_immutable_tree(self.runtime)
        self.assertEqual(calls, 4)

    def test_inventory_cli_real_default_node_limit_and_first_excess(self):
        # Actual production-default boundary, not a fake provider/native run.
        for index in range(qemu_gssapi.IMMUTABLE_NODE_LIMIT - 1):
            (self.runtime / ('n%05d' % index)).mkdir()
        command = [sys.executable, '-I', '-S', '-B', str(qemu_gssapi.__file__),
                   '--runtime-dir', str(self.runtime), '--inventory-only']
        output = self.root / 'public-measurement.json'
        with output.open('wb') as stream:
            result = subprocess.run(command, stdout=stream, stderr=subprocess.PIPE, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(output.read_text())
        self.assertEqual(len(report['tree']['nodes']), qemu_gssapi.IMMUTABLE_NODE_LIMIT)
        self.assertIs(report['measurementOnly'], True)
        self.assertIs(report['runtimeVerified'], False)
        self.assertIs(report['attributionVerified'], False)
        (self.runtime / 'first-excess').mkdir()
        result = subprocess.run(command, text=True, capture_output=True, timeout=30)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')
        self.assertIn('immutable directory entry budget refused', result.stderr)
        self.assertFalse((self.root / 'fixture').exists())

    def test_regular_size_budget_refuses_before_reading_sparse_data(self):
        path = self.runtime / 'sparse-public.canary'
        with path.open('wb') as stream:
            stream.truncate(128 * 1024 * 1024 + 1)
        with self.assertRaisesRegex(ValueError, 'regular byte budget'):
            qemu_gssapi.measure_immutable_tree(self.runtime)

    def test_observed_real_fd_byte_mutation_fails_closed(self):
        path = self.runtime / 'public.canary'
        path.write_bytes(b'public initial bytes')
        original_read, changed = os.read, False
        def mutate_after_actual_read(fd, count):
            nonlocal changed
            data = original_read(fd, count)
            if data and not changed:
                changed = True
                path.write_bytes(b'public changed bytes')
            return data
        descriptors = set(os.listdir('/proc/self/fd'))
        with mock.patch.object(qemu_gssapi.os, 'read', side_effect=mutate_after_actual_read):
            with self.assertRaisesRegex(ValueError, 'changed while measured'):
                qemu_gssapi.measure_immutable_tree(self.runtime)
        self.assertTrue(changed)
        self.assertEqual(set(os.listdir('/proc/self/fd')), descriptors)

    def test_unsupported_attribute_read_fails_closed_not_empty(self):
        with mock.patch.object(qemu_gssapi.os, 'listxattr', side_effect=OSError(errno.ENOTSUP, 'public unsupported metadata')):
            with self.assertRaises(OSError):
                qemu_gssapi.measure_immutable_tree(self.runtime)

    def test_live_root_and_symlink_root_have_no_measurement_bypass(self):
        with self.assertRaisesRegex(ValueError, 'mounted controller unavailable'):
            qemu_gssapi.measure_immutable_tree(pathlib.Path('/'))
        alias = self.root / 'root.alias'
        alias.symlink_to(self.runtime)
        with self.assertRaisesRegex(ValueError, 'staging root refused'):
            qemu_gssapi.measure_immutable_tree(alias)

    def test_inventory_only_cli_reports_measurement_without_native_actions(self):
        (self.runtime / 'public.canary').write_bytes(b'public metadata-only input')
        command = [sys.executable, '-B', str(qemu_gssapi.__file__), '--runtime-dir', str(self.runtime), '--inventory-only']
        result = subprocess.run(command, text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertIs(report['measurementOnly'], True)
        self.assertIs(report['runtimeVerified'], False)
        self.assertIs(report['attributionVerified'], False)
        self.assertEqual(report['treeSha256'], qemu_gssapi.immutable_tree_digest(report['tree']))
        self.assertEqual(set(self.root.iterdir()), {self.runtime})
        result = subprocess.run(command + ['--test-executable', str(self.root / 'never-execute.canary')],
                                text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, '')
        self.assertEqual(set(self.root.iterdir()), {self.runtime})

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
