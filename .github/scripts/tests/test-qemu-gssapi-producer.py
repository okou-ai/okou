#!/usr/bin/env python3
"""Public inert input tests; no QEMU/helper/signature/runtime is impersonated."""
import ast
import errno
import gzip
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import signal
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
import unittest.mock as mock

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

    def public_deb_format_canary(self, base, count, *, roots_only=False):
        # Only a public ar/tar format canary, NOT a signed Ubuntu input. The
        # real dpkg-deb decodes data; no package program/maintainer script exists.
        packed = io.BytesIO()
        root = tarfile.TarInfo('.')
        root.type = tarfile.DIRTYPE
        header = root.tobuf(format=tarfile.USTAR_FORMAT)
        if not roots_only:
            member = tarfile.TarInfo('public-parser-canary')
            member.mode = 0o600
            header = member.tobuf(format=tarfile.USTAR_FORMAT)
        with gzip.GzipFile(fileobj=packed, mode='wb', compresslevel=1, mtime=0) as stream:
            if not roots_only:
                stream.write(root.tobuf(format=tarfile.USTAR_FORMAT))
            chunk = header * 4096
            for _ in range(count // 4096):
                stream.write(chunk)
            stream.write(header * (count % 4096))
            stream.write(b'\0' * 1024)
        archive = base / 'public-format-canary.deb'
        with archive.open('xb') as output:
            output.write(b'!<arch>\n')
            for name, data in [('debian-binary', b'2.0\n'),
                               ('control.tar.gz', gzip.compress(b'\0' * 10240, mtime=0)),
                               ('data.tar.gz', packed.getvalue())]:
                fields = ((name + '/').ljust(16) + '0'.ljust(12) + '0'.ljust(6)
                          + '0'.ljust(6) + '100600'.ljust(8) + str(len(data)).ljust(10) + '`\n')
                self.assertEqual(len(fields.encode()), 60)
                output.write(fields.encode())
                output.write(data)
                if len(data) % 2:
                    output.write(b'\n')
        return archive

    def test_package_entry_budget_refuses_before_unbounded_header_allocation(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            base = pathlib.Path(directory)
            archive = self.public_deb_format_canary(base, 900000)
            destination = base / 'root'
            destination.mkdir(mode=0o700)
            # The public decoded bytes fit the unchanged512MiB limit. Use a
            # real child-local memory limit to distinguish bounded refusal from
            # eager getmembers() MemoryError, not a mocked decoder/result.
            script = '''
import importlib.util, pathlib, resource, sys
resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024, 256 * 1024 * 1024))
spec = importlib.util.spec_from_file_location('real_producer', sys.argv[1])
producer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(producer)
try:
    producer.extract_deb(pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]))
except ValueError as error:
    if str(error) != 'source-pinned fixture package entry budget refused':
        raise
else:
    raise AssertionError('over-budget public payload was accepted')
if list(pathlib.Path(sys.argv[3]).iterdir()):
    raise AssertionError('over-budget payload changed the extraction root')
'''
            result = subprocess.run([sys.executable, '-I', '-S', '-B', '-c', script,
                                     str(ROOT / '.github/scripts/prepare-qemu-gssapi-fixture.py'),
                                     str(archive), str(destination)], capture_output=True, text=True, timeout=60,
                                    env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(list(destination.iterdir()), [])
            self.assertEqual(set(path.name for path in base.iterdir()), {'root', archive.name})

    def test_skipped_package_root_headers_cannot_evade_entry_budget(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            base = pathlib.Path(directory)
            archive = self.public_deb_format_canary(base, 50002, roots_only=True)
            destination = base / 'root'
            destination.mkdir(mode=0o700)
            descriptors = len(list(pathlib.Path('/proc/self/fd').iterdir()))
            with self.assertRaisesRegex(ValueError, 'package entry budget refused'):
                self.producer.extract_deb(archive, destination)
            self.assertEqual(len(list(pathlib.Path('/proc/self/fd').iterdir())), descriptors)
            self.assertEqual(list(destination.iterdir()), [])
            self.assertEqual(set(path.name for path in base.iterdir()), {'root', archive.name})

    def test_package_exact_entry_budget_and_root_header_remain_admitted(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            base = pathlib.Path(directory)
            archive = self.public_deb_format_canary(base, 50000)
            destination = base / 'root'
            destination.mkdir(mode=0o700)
            self.producer.extract_deb(archive, destination)
            # Repeated harmless headers intentionally count as entries rather
            # than deduplicating names to defeat the resource limit.
            self.assertEqual(list(path.name for path in destination.iterdir()), ['public-parser-canary'])
            self.assertEqual((destination / 'public-parser-canary').read_bytes(), b'')
            self.assertEqual((destination / 'public-parser-canary').stat().st_mode & 0o777, 0o600)
            self.assertEqual(set(path.name for path in base.iterdir()), {'root', archive.name})

    def public_payload_deb(self, base, payload, *, control=None):
        # Inert format input only, decoded by the real installed dpkg-deb.
        archive = base / 'public-payload-canary.deb'
        with archive.open('xb') as output:
            output.write(b'!<arch>\n')
            for name, data in [('debian-binary', b'2.0\n'),
                               ('control.tar.gz', gzip.compress(b'\0' * 10240 if control is None else control, mtime=0)),
                               ('data.tar.gz', gzip.compress(payload, mtime=0))]:
                fields = ((name + '/').ljust(16) + '0'.ljust(12) + '0'.ljust(6)
                          + '0'.ljust(6) + '100600'.ljust(8) + str(len(data)).ljust(10) + '`\n')
                output.write(fields.encode())
                output.write(data)
                if len(data) % 2:
                    output.write(b'\n')
        return archive

    def test_default_output_depth_refuses_before_creating_any_implicit_parent(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            base = pathlib.Path(directory)
            packed = io.BytesIO()
            with tarfile.open(fileobj=packed, mode='w') as stream:
                member = tarfile.TarInfo('/'.join(['d'] * 128 + ['public']))
                member.size = 4
                stream.addfile(member, io.BytesIO(b'data'))
            archive = self.public_payload_deb(base, packed.getvalue())
            root = base / 'root'
            root.mkdir()
            with self.assertRaisesRegex(ValueError, 'output path/byte budget refused'):
                self.producer.extract_deb(archive, root)
            self.assertEqual(list(root.iterdir()), [])

    def test_default_output_hardlink_name_total_refuses_logical_expansion(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            base = pathlib.Path(directory)
            size = 128 * 1024 * 1024
            member = tarfile.TarInfo('sparse-public')
            member.type = tarfile.GNUTYPE_SPARSE
            member.mode = 0o600
            member.size = 1
            header = bytearray(member.tobuf(format=tarfile.GNU_FORMAT))
            header[386:398] = tarfile.itn(size - 1, 12)
            header[398:410] = tarfile.itn(1, 12)
            header[483:495] = tarfile.itn(size, 12)
            header[148:156] = b' ' * 8
            header[148:156] = bytes('%06o\0 ' % sum(header), 'ascii')
            payload = bytes(header) + b'x' + b'\0' * 511
            for index in range(1, 18):
                alias = tarfile.TarInfo('alias-' + str(index))
                alias.type = tarfile.LNKTYPE
                alias.linkname = member.name
                payload += alias.tobuf(format=tarfile.GNU_FORMAT)
            archive = self.public_payload_deb(base, payload + b'\0' * 1024)
            root = base / 'root'
            root.mkdir()
            with self.assertRaisesRegex(ValueError, 'output aggregate budget refused'):
                self.producer.extract_deb(archive, root)
            self.assertEqual((root / member.name).stat().st_size, size)
            self.assertEqual((root / member.name).stat().st_ino, (root / 'alias-15').stat().st_ino)
            self.assertFalse((root / 'alias-16').exists())
            self.assertEqual(sum(path.stat().st_size for path in root.iterdir()), 2 * 1024 * 1024 * 1024)

    def test_output_late_collisions_cannot_resize_hardlinks_or_follow_dangling_leaf_aliases(self):
        for kind in ('hardlink', 'dangling'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory(dir=self.parent) as directory:
                base = pathlib.Path(directory)
                packed = io.BytesIO()
                with tarfile.open(fileobj=packed, mode='w') as stream:
                    if kind == 'hardlink':
                        member = tarfile.TarInfo('original')
                        member.size = 4
                        stream.addfile(member, io.BytesIO(b'data'))
                        member = tarfile.TarInfo('second')
                        member.type = tarfile.LNKTYPE
                        member.linkname = 'original'
                        stream.addfile(member)
                    else:
                        member = tarfile.TarInfo('original')
                        member.type = tarfile.SYMTYPE
                        member.linkname = 'missing'
                        stream.addfile(member)
                    member = tarfile.TarInfo('original')
                    member.size = 5
                    stream.addfile(member, io.BytesIO(b'other'))
                archive = self.public_payload_deb(base, packed.getvalue())
                root = base / 'root'
                root.mkdir()
                with self.assertRaisesRegex(ValueError, 'file collision refused'):
                    self.producer.extract_deb(archive, root)
                if kind == 'hardlink':
                    self.assertEqual((root / 'original').read_bytes(), b'data')
                    self.assertEqual((root / 'second').read_bytes(), b'data')
                    self.assertEqual((root / 'original').stat().st_ino, (root / 'second').stat().st_ino)
                else:
                    self.assertEqual(os.readlink(root / 'original'), 'missing')
                    self.assertFalse((root / 'missing').exists())

    def test_output_hardlink_fallback_refuses_before_resizing_shared_inode(self):
        for source_bytes, accepted in ((b'other', False), (b'data', True)):
            with self.subTest(source=source_bytes), tempfile.TemporaryDirectory(dir=self.parent) as directory:
                base = pathlib.Path(directory)
                packed = io.BytesIO()
                with tarfile.open(fileobj=packed, mode='w') as stream:
                    member = tarfile.TarInfo('original')
                    member.size = 4
                    stream.addfile(member, io.BytesIO(b'data'))
                    member = tarfile.TarInfo('second')
                    member.type = tarfile.LNKTYPE
                    member.linkname = 'original'
                    stream.addfile(member)
                    member = tarfile.TarInfo('source')
                    member.size = len(source_bytes)
                    stream.addfile(member, io.BytesIO(source_bytes))
                    member = tarfile.TarInfo('original')
                    member.type = tarfile.LNKTYPE
                    member.linkname = 'source'
                    stream.addfile(member)
                archive = self.public_payload_deb(base, packed.getvalue())
                root = base / 'root'
                root.mkdir()
                budget = self.producer.PackageExtractionBudget(output_bytes=12 if accepted else 14)
                descriptors = len(list(pathlib.Path('/proc/self/fd').iterdir()))
                if accepted:
                    self.producer.extract_deb(archive, root, budget)
                else:
                    with self.assertRaisesRegex(ValueError, 'file collision refused'):
                        self.producer.extract_deb(archive, root, budget)
                self.assertEqual(len(list(pathlib.Path('/proc/self/fd').iterdir())), descriptors)
                self.assertEqual((root / 'original').read_bytes(), b'data')
                self.assertEqual((root / 'second').read_bytes(), b'data')
                self.assertEqual((root / 'source').read_bytes(), source_bytes)
                self.assertEqual((root / 'original').stat().st_ino, (root / 'second').stat().st_ino)
                self.assertEqual(sum(path.stat().st_size for path in root.iterdir()), 12 if accepted else 13)
                self.assertEqual(set(path.name for path in base.iterdir()), {'root', archive.name})

    def test_output_hardlink_fallback_refuses_before_following_dangling_alias(self):
        for dangling in (True, False):
            with self.subTest(dangling=dangling), tempfile.TemporaryDirectory(dir=self.parent) as directory:
                base = pathlib.Path(directory)
                packed = io.BytesIO()
                with tarfile.open(fileobj=packed, mode='w') as stream:
                    member = tarfile.TarInfo('source')
                    member.size = 4
                    stream.addfile(member, io.BytesIO(b'data'))
                    if dangling:
                        member = tarfile.TarInfo('route')
                        member.type = tarfile.SYMTYPE
                        member.linkname = 'missing'
                        stream.addfile(member)
                    member = tarfile.TarInfo('route')
                    member.type = tarfile.LNKTYPE
                    member.linkname = 'source'
                    stream.addfile(member)
                archive = self.public_payload_deb(base, packed.getvalue())
                root = base / 'root'
                root.mkdir()
                budget = self.producer.PackageExtractionBudget(output_nodes=3, output_bytes=8)
                descriptors = len(list(pathlib.Path('/proc/self/fd').iterdir()))
                if dangling:
                    with self.assertRaisesRegex(ValueError, 'file collision refused'):
                        self.producer.extract_deb(archive, root, budget)
                    self.assertEqual(os.readlink(root / 'route'), 'missing')
                    self.assertFalse((root / 'missing').exists())
                    self.assertEqual(set(path.name for path in root.iterdir()), {'source', 'route'})
                else:
                    self.producer.extract_deb(archive, root, budget)
                    self.assertEqual((root / 'route').read_bytes(), b'data')
                    self.assertEqual((root / 'source').stat().st_ino, (root / 'route').stat().st_ino)
                self.assertEqual(len(list(pathlib.Path('/proc/self/fd').iterdir())), descriptors)
                self.assertEqual((root / 'source').read_bytes(), b'data')
                self.assertEqual(set(path.name for path in base.iterdir()), {'root', archive.name})

    def test_hardlink_fallback_filters_relocated_symlink_before_unlinking_destination(self):
        for destination, accepted in (('route', False), ('dir/sub/copy', True)):
            with self.subTest(destination=destination), tempfile.TemporaryDirectory(dir=self.parent) as directory:
                base = pathlib.Path(directory)
                packed = io.BytesIO()
                with tarfile.open(fileobj=packed, mode='w') as stream:
                    member = tarfile.TarInfo('value')
                    member.size = 4
                    stream.addfile(member, io.BytesIO(b'data'))
                    member = tarfile.TarInfo('dir/sub/link')
                    member.type = tarfile.SYMTYPE
                    member.linkname = '../../value'
                    stream.addfile(member)
                    member = tarfile.TarInfo(destination)
                    member.size = 4
                    stream.addfile(member, io.BytesIO(b'data'))
                    member = tarfile.TarInfo(destination)
                    member.type = tarfile.LNKTYPE
                    member.linkname = 'dir/sub/link'
                    stream.addfile(member)
                archive = self.public_payload_deb(base, packed.getvalue())
                root = base / 'root'
                root.mkdir()
                descriptors = len(list(pathlib.Path('/proc/self/fd').iterdir()))
                if accepted:
                    self.producer.extract_deb(archive, root)
                    self.assertTrue((root / destination).is_symlink())
                    self.assertEqual(os.readlink(root / destination), '../../value')
                else:
                    with self.assertRaises(tarfile.LinkOutsideDestinationError):
                        self.producer.extract_deb(archive, root)
                    self.assertFalse((root / destination).is_symlink())
                self.assertEqual((root / destination).read_bytes(), b'data')
                self.assertEqual((root / 'value').read_bytes(), b'data')
                self.assertEqual(os.readlink(root / 'dir/sub/link'), '../../value')
                self.assertEqual(len(list(pathlib.Path('/proc/self/fd').iterdir())), descriptors)
                self.assertEqual(set(path.name for path in base.iterdir()), {'root', archive.name})

    def test_nested_hardlink_fallback_filters_actual_archive_entry_at_its_destination(self):
        for destination, accepted in (('route', False), ('dir/sub/copy', True)):
            with self.subTest(destination=destination), tempfile.TemporaryDirectory(dir=self.parent) as directory:
                base = pathlib.Path(directory)
                packed = io.BytesIO()
                with tarfile.open(fileobj=packed, mode='w') as stream:
                    member = tarfile.TarInfo('value')
                    member.size = 4
                    stream.addfile(member, io.BytesIO(b'data'))
                    member = tarfile.TarInfo('dir/sub/link')
                    member.type = tarfile.SYMTYPE
                    member.linkname = '../../value'
                    stream.addfile(member)
                    member = tarfile.TarInfo('dir/sub/hop')
                    member.type = tarfile.LNKTYPE
                    member.linkname = 'dir/sub/link'
                    stream.addfile(member)
                    member = tarfile.TarInfo(destination)
                    member.size = 4
                    stream.addfile(member, io.BytesIO(b'data'))
                    member = tarfile.TarInfo(destination)
                    member.type = tarfile.LNKTYPE
                    member.linkname = 'dir/sub/hop'
                    stream.addfile(member)
                archive = self.public_payload_deb(base, packed.getvalue())
                root = base / 'root'
                root.mkdir()
                descriptors = len(list(pathlib.Path('/proc/self/fd').iterdir()))
                if accepted:
                    self.producer.extract_deb(archive, root)
                    self.assertEqual(os.readlink(root / destination), '../../value')
                else:
                    with self.assertRaises(tarfile.LinkOutsideDestinationError):
                        self.producer.extract_deb(archive, root)
                    self.assertFalse((root / destination).is_symlink())
                self.assertEqual((root / destination).read_bytes(), b'data')
                self.assertEqual((root / 'value').read_bytes(), b'data')
                self.assertEqual(os.readlink(root / 'dir/sub/hop'), '../../value')
                self.assertEqual(len(list(pathlib.Path('/proc/self/fd').iterdir())), descriptors)
                self.assertEqual(set(path.name for path in base.iterdir()), {'root', archive.name})

    def test_missing_hardlink_target_filters_actual_dangling_symlink_at_new_location(self):
        # The archived link target exists as an entry but its ultimate regular
        # file appears later. Real makelink therefore takes its missing-target
        # copy branch, independently of the existing-destination/EEXIST branch.
        for destination, accepted in (('route', False), ('dir/sub/copy', True)):
            with self.subTest(destination=destination), tempfile.TemporaryDirectory(dir=self.parent) as directory:
                base = pathlib.Path(directory)
                packed = io.BytesIO()
                with tarfile.open(fileobj=packed, mode='w') as stream:
                    member = tarfile.TarInfo('dir/sub/link')
                    member.type = tarfile.SYMTYPE
                    member.linkname = '../../value'
                    stream.addfile(member)
                    member = tarfile.TarInfo(destination)
                    member.type = tarfile.LNKTYPE
                    member.linkname = 'dir/sub/link'
                    stream.addfile(member)
                    member = tarfile.TarInfo('value')
                    member.size = 4
                    stream.addfile(member, io.BytesIO(b'data'))
                archive = self.public_payload_deb(base, packed.getvalue())
                root = base / 'root'
                root.mkdir()
                descriptors = len(list(pathlib.Path('/proc/self/fd').iterdir()))
                if accepted:
                    self.producer.extract_deb(archive, root)
                    self.assertEqual(os.readlink(root / destination), '../../value')
                    self.assertEqual((root / destination).read_bytes(), b'data')
                    self.assertEqual((root / 'value').read_bytes(), b'data')
                else:
                    with self.assertRaises(tarfile.LinkOutsideDestinationError):
                        self.producer.extract_deb(archive, root)
                    self.assertFalse(os.path.lexists(root / destination))
                    self.assertFalse((root / 'value').exists())
                self.assertEqual(os.readlink(root / 'dir/sub/link'), '../../value')
                self.assertEqual(len(list(pathlib.Path('/proc/self/fd').iterdir())), descriptors)
                self.assertEqual(set(path.name for path in base.iterdir()), {'root', archive.name})

    def test_hardlink_fallback_reapplies_data_filter_to_actual_regular_metadata(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            base = pathlib.Path(directory)
            packed = io.BytesIO()
            with tarfile.open(fileobj=packed, mode='w') as stream:
                for name in ('source', 'route'):
                    member = tarfile.TarInfo(name)
                    member.size = 4
                    member.mode = 0o666
                    stream.addfile(member, io.BytesIO(b'data'))
                member = tarfile.TarInfo('route')
                member.type = tarfile.LNKTYPE
                member.linkname = 'source'
                member.mode = 0o644
                stream.addfile(member)
            archive = self.public_payload_deb(base, packed.getvalue())
            root = base / 'root'
            root.mkdir()
            self.producer.extract_deb(archive, root)
            self.assertEqual((root / 'route').read_bytes(), b'data')
            self.assertEqual((root / 'source').read_bytes(), b'data')
            self.assertEqual((root / 'route').stat().st_mode & 0o777, 0o644)
            self.assertEqual((root / 'source').stat().st_mode & 0o777, 0o644)
            self.assertEqual(set(path.name for path in base.iterdir()), {'root', archive.name})

    def test_repeated_hardlink_copy_work_consumes_capacity_without_name_deduplication(self):
        for capacity, accepted in ((11, False), (12, True)):
            with self.subTest(capacity=capacity), tempfile.TemporaryDirectory(dir=self.parent) as directory:
                base = pathlib.Path(directory)
                packed = io.BytesIO()
                with tarfile.open(fileobj=packed, mode='w') as stream:
                    member = tarfile.TarInfo('source')
                    member.size = 4
                    stream.addfile(member, io.BytesIO(b'data'))
                    for _ in range(2):
                        member = tarfile.TarInfo('route')
                        member.type = tarfile.LNKTYPE
                        member.linkname = 'source'
                        stream.addfile(member)
                archive = self.public_payload_deb(base, packed.getvalue())
                root = base / 'root'
                root.mkdir()
                budget = self.producer.PackageExtractionBudget(total_bytes=capacity, output_nodes=3, output_bytes=8)
                if accepted:
                    self.producer.extract_deb(archive, root, budget)
                else:
                    with self.assertRaisesRegex(ValueError, 'aggregate extraction budget refused'):
                        self.producer.extract_deb(archive, root, budget)
                self.assertEqual((root / 'source').read_bytes(), b'data')
                self.assertEqual((root / 'route').read_bytes(), b'data')
                self.assertEqual((root / 'source').stat().st_ino, (root / 'route').stat().st_ino)
                self.assertEqual(budget.remaining_bytes, 0 if accepted else 3)
                self.assertEqual(budget.output_bytes, 8)

    def test_output_nodes_include_implicit_parents_and_refuse_before_their_writes(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            base = pathlib.Path(directory)
            packed = io.BytesIO()
            with tarfile.open(fileobj=packed, mode='w') as stream:
                member = tarfile.TarInfo('a/b/public')
                member.size = 4
                stream.addfile(member, io.BytesIO(b'data'))
            archive = self.public_payload_deb(base, packed.getvalue())
            root = base / 'root'
            root.mkdir()
            with self.assertRaisesRegex(ValueError, 'output aggregate budget refused'):
                self.producer.extract_deb(archive, root, self.producer.PackageExtractionBudget(output_nodes=3))
            self.assertEqual(list(root.iterdir()), [])
            self.producer.extract_deb(archive, root, self.producer.PackageExtractionBudget(output_nodes=4))
            self.assertEqual((root / 'a/b/public').read_bytes(), b'data')
            for limits in ({'output_nodes': True}, {'output_nodes': 20001}, {'output_bytes': 0}, {'output_names': 0}):
                with self.assertRaisesRegex(ValueError, 'extraction budget refused'):
                    self.producer.PackageExtractionBudget(**limits)

    def test_output_regular_bytes_charge_every_actual_hardlink_name(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            base = pathlib.Path(directory)
            packed = io.BytesIO()
            with tarfile.open(fileobj=packed, mode='w') as stream:
                member = tarfile.TarInfo('original')
                member.size = 4
                stream.addfile(member, io.BytesIO(b'data'))
                for name in ('second', 'third'):
                    member = tarfile.TarInfo(name)
                    member.type = tarfile.LNKTYPE
                    member.linkname = 'original'
                    stream.addfile(member)
            archive = self.public_payload_deb(base, packed.getvalue())
            root = base / 'root'
            root.mkdir()
            with self.assertRaisesRegex(ValueError, 'output aggregate budget refused'):
                self.producer.extract_deb(archive, root, self.producer.PackageExtractionBudget(output_bytes=11))
            self.assertFalse((root / 'third').exists())
            self.assertEqual((root / 'original').read_bytes(), b'data')
            self.assertEqual((root / 'original').stat().st_ino, (root / 'second').stat().st_ino)
            self.producer.extract_deb(archive, root, self.producer.PackageExtractionBudget(output_bytes=12))
            self.assertEqual((root / 'original').stat().st_ino, (root / 'third').stat().st_ino)

    def test_output_budget_uses_current_alias_parent_not_reused_archive_name(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            base = pathlib.Path(directory)
            packed = io.BytesIO()
            with tarfile.open(fileobj=packed, mode='w') as stream:
                for name in ('first', 'second'):
                    member = tarfile.TarInfo(name)
                    member.type = tarfile.DIRTYPE
                    stream.addfile(member)
                for target in ('first', 'second'):
                    member = tarfile.TarInfo('route')
                    member.type = tarfile.SYMTYPE
                    member.linkname = target
                    stream.addfile(member)
                    member = tarfile.TarInfo('route/public')
                    member.size = 4
                    stream.addfile(member, io.BytesIO(b'data'))
            archive = self.public_payload_deb(base, packed.getvalue())
            root = base / 'root'
            root.mkdir()
            with self.assertRaisesRegex(ValueError, 'output aggregate budget refused'):
                self.producer.extract_deb(archive, root, self.producer.PackageExtractionBudget(output_nodes=5))
            self.assertEqual((root / 'first/public').read_bytes(), b'data')
            self.assertEqual(os.readlink(root / 'route'), 'second')
            self.assertFalse((root / 'second/public').exists())
            other = base / 'other'
            other.mkdir()
            self.producer.extract_deb(archive, other, self.producer.PackageExtractionBudget(output_nodes=6, output_bytes=8))
            self.assertEqual((other / 'second/public').read_bytes(), b'data')
            self.assertNotEqual((other / 'first/public').stat().st_ino, (other / 'second/public').stat().st_ino)

    def test_output_existing_tree_shared_packages_names_and_future_capacity_are_bounded(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            base = pathlib.Path(directory)
            packed = io.BytesIO()
            with tarfile.open(fileobj=packed, mode='w') as stream:
                member = tarfile.TarInfo('public')
                member.size = 4
                stream.addfile(member, io.BytesIO(b'data'))
            archive = self.public_payload_deb(base, packed.getvalue())
            root = base / 'root'
            root.mkdir()
            budget = self.producer.PackageExtractionBudget(output_nodes=2, output_names=12, output_bytes=4)
            self.producer.extract_deb(archive, root, budget)
            # Equal collisions retain the existing node but still consume the
            # separate archive/decoded/header/regular-work budgets.
            self.producer.extract_deb(archive, root, budget)
            self.assertEqual(list(path.name for path in root.iterdir()), ['public'])
            for limits in ({'output_nodes': 1}, {'output_names': 11}, {'output_bytes': 3}):
                with self.assertRaisesRegex(ValueError, 'output aggregate budget refused'):
                    self.producer.extract_deb(archive, root, self.producer.PackageExtractionBudget(**limits))
            future = base / 'future'
            future.mkdir()
            with self.assertRaisesRegex(ValueError, 'output aggregate budget refused'):
                self.producer.PackageExtractionBudget(output_bytes=128 * 1024 * 1024).reserve_future_outputs(future)
            self.assertEqual(list(future.iterdir()), [])
            with self.assertRaisesRegex(ValueError, 'output root changed'):
                self.producer.extract_deb(archive, future, budget)
            self.assertEqual(list(future.iterdir()), [])

    def public_control_archive(self, *, package='public-canary', version='1'):
        fields = ('Package: ' + package + '\nVersion: ' + version + '\nArchitecture: all\n'
                  'Maintainer: Public Fixture <nobody@issue37612.invalid>\n'
                  'Description: inert public format data\n').encode()
        packed = io.BytesIO()
        with tarfile.open(fileobj=packed, mode='w', format=tarfile.USTAR_FORMAT) as stream:
            member = tarfile.TarInfo('./control')
            member.mode = 0o644
            member.size = len(fields)
            stream.addfile(member, io.BytesIO(fields))
        return packed.getvalue()

    def test_compressed_collection_bounds_physical_entries_and_bytes_before_decoders(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            base = pathlib.Path(directory)
            archives = base / 'archives'
            archives.mkdir()
            for name in ('one.deb', 'two.deb'):
                (archives / name).write_bytes(b'public')
            self.assertEqual(len(self.producer.collect_package_archives(archives, files=2, file_bytes=6, total_bytes=12)), 2)
            for limits in ({'files': 1}, {'file_bytes': 5}, {'total_bytes': 11}, {'files': True}, {'files': 201}):
                with self.assertRaisesRegex(ValueError, 'compressed archive.*budget refused'):
                    self.producer.collect_package_archives(archives, **limits)
            (archives / 'two.deb').unlink()
            (archives / 'two.deb').symlink_to('one.deb')
            with self.assertRaisesRegex(ValueError, 'fixture archive refused'):
                self.producer.collect_package_archives(archives)
            (archives / 'two.deb').unlink()
            (archives / 'extra').write_bytes(b'unexpected')
            with self.assertRaisesRegex(ValueError, 'fixture archive refused'):
                self.producer.collect_package_archives(archives)

    def test_collected_original_replaced_by_real_fifo_refuses_without_waiting_for_writer(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            base = pathlib.Path(directory)
            archive = base / 'public.deb'
            archive.write_bytes(b'public original bytes')
            collected = self.producer.collect_package_archives(base)
            self.assertEqual(collected, [archive])
            archive.unlink()
            os.mkfifo(archive, mode=0o600)  # No writer is ever opened.
            script = '''
import importlib.util, os, pathlib, sys
spec = importlib.util.spec_from_file_location('actual_producer', sys.argv[1])
producer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(producer)
archive = pathlib.Path(sys.argv[2])
fd_count = len(list(pathlib.Path('/proc/self/fd').iterdir()))
try:
    with producer.opened_package_archive(archive):
        raise AssertionError('FIFO admitted as regular original')
except ValueError as error:
    assert str(error) == 'package compressed archive budget refused'
assert len(list(pathlib.Path('/proc/self/fd').iterdir())) == fd_count
assert pathlib.Path('/proc/self/task/' + str(os.getpid()) + '/children').read_text().strip() == ''
print('held FIFO refused; no descriptor or decoder child remains')
'''
            child = subprocess.Popen([sys.executable, '-I', '-S', '-B', '-c', script,
                                      str(ROOT / '.github/scripts/prepare-qemu-gssapi-fixture.py'), str(collected[0])],
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                     env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'})
            try:
                output, error = child.communicate(timeout=3)
            finally:
                if child.poll() is None:
                    child.kill()
                child.wait(timeout=3)
                child.stdout.close()
                child.stderr.close()
            self.assertEqual(child.returncode, 0, error)
            self.assertIn('held FIFO refused', output)
            self.assertFalse(pathlib.Path('/proc/' + str(child.pid)).exists())
            self.assertEqual(set(path.name for path in base.iterdir()), {'public.deb'})
            archive.unlink()
            archive.write_bytes(b'public original bytes')
            descriptors = len(list(pathlib.Path('/proc/self/fd').iterdir()))
            with self.producer.opened_package_archive(archive) as (fd, digest, size, _):
                self.assertEqual(os.pread(fd, size, 0), b'public original bytes')
                self.assertEqual(digest, hashlib.sha256(b'public original bytes').hexdigest())
            self.assertEqual(len(list(pathlib.Path('/proc/self/fd').iterdir())), descriptors)

    def test_opened_archive_bounds_reads_closes_fd_and_detects_actual_writer_change(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            base = pathlib.Path(directory)
            archive = base / 'public.deb'
            archive.write_bytes(b'public format bytes')
            descriptors = len(list(pathlib.Path('/proc/self/fd').iterdir()))
            with self.assertRaisesRegex(ValueError, 'compressed archive budget refused'):
                with self.producer.opened_package_archive(archive, maximum_bytes=4):
                    self.fail('over-budget original was hashed or admitted')
            with self.assertRaisesRegex(ValueError, 'fixture archive changed'):
                with self.producer.opened_package_archive(archive) as (fd, digest, size, identity):
                    self.assertEqual(digest, hashlib.sha256(archive.read_bytes()).hexdigest())
                    self.assertEqual(size, 19)
                    with archive.open('r+b') as writer:
                        writer.write(b'changed')
                    self.assertNotEqual(os.fstat(fd).st_ctime_ns, identity[-1])
            self.assertEqual(len(list(pathlib.Path('/proc/self/fd').iterdir())), descriptors)

    def test_opened_archive_closes_borrowed_descriptor_when_body_raises(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            archive = pathlib.Path(directory) / 'public.deb'
            archive.write_bytes(b'public borrower-exception canary; not a package')
            descriptors = len(list(pathlib.Path('/proc/self/fd').iterdir()))
            with self.assertRaisesRegex(RuntimeError, 'inert borrower failed'):
                with self.producer.opened_package_archive(archive) as (fd, _, _, _):
                    self.assertTrue(os.fstat(fd))
                    raise RuntimeError('inert borrower failed')
            with self.assertRaises(OSError) as closed:
                os.fstat(fd)
            self.assertEqual(closed.exception.errno, errno.EBADF)
            self.assertEqual(len(list(pathlib.Path('/proc/self/fd').iterdir())), descriptors)

    def test_opened_archive_closes_borrowed_descriptor_after_real_sigint(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            archive = pathlib.Path(directory) / 'public.deb'
            archive.write_bytes(b'public interruption canary; not a package')
            descriptors = len(list(pathlib.Path('/proc/self/fd').iterdir()))
            with self.assertRaises(KeyboardInterrupt):
                with self.producer.opened_package_archive(archive) as (fd, _, _, _):
                    signal.raise_signal(signal.SIGINT)
            with self.assertRaises(OSError) as closed:
                os.fstat(fd)
            self.assertEqual(closed.exception.errno, errno.EBADF)
            self.assertEqual(len(list(pathlib.Path('/proc/self/fd').iterdir())), descriptors)

    def test_real_control_and_data_decoders_use_held_original_not_replaced_name(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            base = pathlib.Path(directory)
            packed = io.BytesIO()
            with tarfile.open(fileobj=packed, mode='w') as stream:
                member = tarfile.TarInfo('original-public-data')
                member.size = 6
                stream.addfile(member, io.BytesIO(b'public'))
            archive = self.public_payload_deb(base, packed.getvalue(), control=self.public_control_archive())
            descriptor = os.open(archive, os.O_RDONLY | os.O_CLOEXEC)
            try:
                archive.rename(base / 'held-original.deb')
                archive.write_bytes(b'not a deb and never a signed provider input')
                self.assertEqual(self.producer.package_control_fields(archive, descriptor),
                                 {'Package': 'public-canary', 'Version': '1', 'Architecture': 'all'})
                root = base / 'root'
                root.mkdir()
                self.producer.extract_deb(archive, root, descriptor=descriptor)
                self.assertEqual((root / 'original-public-data').read_bytes(), b'public')
            finally:
                os.close(descriptor)

    def test_real_control_output_is_kernel_bounded_without_large_parent_capture(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            base = pathlib.Path(directory)
            archive = self.public_payload_deb(base, b'\0' * 10240,
                                              control=self.public_control_archive(version='1' + 'a' * (5 * 1024 * 1024)))
            descriptors = len(list(pathlib.Path('/proc/self/fd').iterdir()))
            with self.producer.opened_package_archive(archive) as (fd, _, _, _):
                with tempfile.TemporaryFile(dir=base) as output:
                    with self.assertRaisesRegex(ValueError, 'fixture package payload refused'):
                        self.producer.decode_package_payload(archive, output, 4 * 1024 * 1024,
                                                             descriptor=fd, control_fields=True)
                    # dpkg's internal control spool hits the file limit before
                    # printing fields; do not invent a 64-KiB stdout outcome.
                    self.assertEqual(output.tell(), 0)
            self.assertEqual(len(list(pathlib.Path('/proc/self/fd').iterdir())), descriptors)

    def test_provision_orders_signed_digest_before_any_control_decoder(self):
        # Structural ordering assertion, not a synthetic authenticated Ubuntu
        # response or a runtime/signed-provider acceptance receipt.
        tree = ast.parse((ROOT / '.github/scripts/prepare-qemu-gssapi-fixture.py').read_text())
        provision = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'provision')
        calls = sorted((node.lineno, node.func.id) for node in ast.walk(provision)
                       if isinstance(node, ast.Call) and isinstance(node.func, ast.Name))
        names = [name for _, name in calls]
        self.assertLess(names.index('collect_package_archives'), names.index('opened_package_archive'))
        self.assertLess(names.index('signed_package_record'), names.index('package_control_fields'))
        self.assertLess(names.index('package_control_fields'), names.index('extract_deb'))
        self.assertFalse(any(isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                             and node.func.id == 'call' and node.args and isinstance(node.args[0], ast.List)
                             and isinstance(node.args[0].elts[0], ast.Constant)
                             and node.args[0].elts[0].value == '/usr/bin/dpkg-deb'
                             for node in ast.walk(provision)))

    def test_package_oversized_pax_is_refused_before_parser_allocation_or_writes(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            base = pathlib.Path(directory)
            extension = tarfile.TarInfo('././@PaxHeader')
            extension.type = tarfile.XHDTYPE
            extension.size = 128 * 1024
            payload = extension.tobuf(format=tarfile.USTAR_FORMAT) + b'0' * extension.size + b'\0' * 1024
            archive = self.public_payload_deb(base, payload)
            root = base / 'root'
            root.mkdir()
            with self.assertRaisesRegex(ValueError, 'archive extension budget refused'):
                self.producer.extract_deb(archive, root)
            self.assertEqual(list(root.iterdir()), [])

    def test_package_pax_logical_size_is_bounded_before_extraction(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            base = pathlib.Path(directory)
            member = tarfile.TarInfo('oversized-logical-file')
            member.pax_headers = {'size': str(128 * 1024 * 1024 + 1)}
            payload = member.tobuf(format=tarfile.PAX_FORMAT) + b'\0' * 1024
            archive = self.public_payload_deb(base, payload)
            root = base / 'root'
            root.mkdir()
            with self.assertRaisesRegex(ValueError, 'archive file byte budget refused'):
                self.producer.extract_deb(archive, root)
            self.assertEqual(list(root.iterdir()), [])

    def test_package_nested_extensions_are_bounded_before_recursive_parser_work(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            base = pathlib.Path(directory)
            extension = tarfile.TarInfo('././@LongLink')
            extension.type = tarfile.GNUTYPE_LONGNAME
            extension.size = 7
            member = tarfile.TarInfo('public')
            payload = (extension.tobuf(format=tarfile.GNU_FORMAT) + b'public\0' + b'\0' * 505) * 32
            payload += member.tobuf(format=tarfile.USTAR_FORMAT) + b'\0' * 1024
            archive = self.public_payload_deb(base, payload)
            root = base / 'root'
            root.mkdir()
            with self.assertRaisesRegex(ValueError, 'archive extension depth refused'):
                self.producer.extract_deb(archive, root)
            self.assertEqual(list(root.iterdir()), [])

    def test_package_sparse_logical_size_is_bounded_before_sparse_expansion(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            base = pathlib.Path(directory)
            member = tarfile.TarInfo('sparse-public-canary')
            member.type = tarfile.GNUTYPE_SPARSE
            header = bytearray(member.tobuf(format=tarfile.GNU_FORMAT))
            header[483:495] = tarfile.itn(128 * 1024 * 1024 + 1, 12)
            header[148:156] = b' ' * 8
            header[148:156] = bytes('%06o\0 ' % sum(header), 'ascii')
            archive = self.public_payload_deb(base, bytes(header) + b'\0' * 1024)
            root = base / 'root'
            root.mkdir()
            with self.assertRaisesRegex(ValueError, 'archive file byte budget refused'):
                self.producer.extract_deb(archive, root)
            self.assertEqual(list(root.iterdir()), [])

    def test_cancelled_decoder_retains_leader_before_actual_group_signal(self):
        # Public bytes use the REAL dpkg-deb/prlimit. Observers delegate real
        # syscalls and inject SIGINT only after kernel-confirmed zombie state.
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            base = pathlib.Path(directory)
            archive = self.public_payload_deb(base, b'\0' * 10240)
            root = base / 'root'
            root.mkdir()
            real_spawn, real_waitid, real_killpg = subprocess.Popen, os.waitid, os.killpg
            children, signals, observations = [], [], []
            interrupted = False

            def observe_spawn(*args, **kwargs):
                child = real_spawn(*args, **kwargs)
                children.append(child)
                return child

            def cancel_after_observation(*args):
                nonlocal interrupted
                result = real_waitid(*args)
                if result is not None and not interrupted:
                    interrupted = True
                    observations.append(result)
                    os.kill(os.getpid(), signal.SIGINT)
                return result

            def signal_reserved_group(pid, signum):
                result = real_waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                self.assertIsNotNone(result)
                self.assertEqual(result.si_pid, children[0].pid)
                signals.append((pid, signum))
                return real_killpg(pid, signum)

            descriptors = len(list(pathlib.Path('/proc/self/fd').iterdir()))
            with mock.patch.object(subprocess, 'Popen', observe_spawn), \
                    mock.patch.object(os, 'waitid', cancel_after_observation), \
                    mock.patch.object(os, 'killpg', signal_reserved_group):
                with self.assertRaises(KeyboardInterrupt):
                    self.producer.extract_deb(archive, root)
            self.assertEqual(len(children), 1)
            self.assertEqual(signals, [(children[0].pid, signal.SIGKILL)])
            self.assertEqual(observations[0].si_code, os.CLD_EXITED)
            self.assertEqual(observations[0].si_status, 0)
            self.assertEqual(children[0].returncode, 0)
            with self.assertRaises(ChildProcessError):
                real_waitid(os.P_PID, children[0].pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            self.assertEqual(len(list(pathlib.Path('/proc/self/fd').iterdir())), descriptors)
            self.assertEqual(list(root.iterdir()), [])

    def test_pending_sigterm_cannot_interrupt_retained_decoder_cleanup(self):
        # The isolated caller installs a raising SIGTERM handler. Real dpkg and
        # syscalls complete; a second signal arrives before the actual group
        # signal. The old cleanup left its kernel-confirmed zombie unreaped.
        script = '''
import hashlib, importlib.util, os, pathlib, signal, subprocess, sys, tempfile
spec = importlib.util.spec_from_file_location('real_producer', sys.argv[1])
producer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(producer)
archive = pathlib.Path(sys.argv[2])
initial_signal = int(sys.argv[3])
original = hashlib.sha256(archive.read_bytes()).digest()
descriptors = len(list(pathlib.Path('/proc/self/fd').iterdir()))
original_mask = signal.pthread_sigmask(signal.SIG_BLOCK, set())
real_spawn, real_waitid, real_killpg = subprocess.Popen, os.waitid, os.killpg
children, observations, signals, terminations = [], [], [], []
interrupted = False

def terminate(signum, frame):
    terminations.append(signum)
    raise SystemExit(128 + signum)

def observe_spawn(*args, **kwargs):
    child = real_spawn(*args, **kwargs)
    children.append(child)
    return child

def cancel_after_observation(*args):
    global interrupted
    result = real_waitid(*args)
    if result is not None and not interrupted:
        interrupted = True
        observations.append(result)
        os.kill(os.getpid(), initial_signal)
    return result

def signal_reserved_group(pid, signum):
    result = real_waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
    assert result is not None and result.si_pid == children[0].pid
    signals.append((pid, signum))
    os.kill(os.getpid(), signal.SIGTERM)
    return real_killpg(pid, signum)

previous = signal.signal(signal.SIGTERM, terminate)
try:
    subprocess.Popen = observe_spawn
    os.waitid = cancel_after_observation
    os.killpg = signal_reserved_group
    try:
        with tempfile.TemporaryFile(dir=archive.parent) as output:
            producer.decode_package_payload(archive, output, 10240)
    except SystemExit as error:
        assert error.code == 128 + signal.SIGTERM
    else:
        raise AssertionError('pending SIGTERM was not propagated')
    assert len(children) == len(observations) == len(signals) == 1
    assert observations[0].si_code == os.CLD_EXITED and observations[0].si_status == 0
    assert signals == [(children[0].pid, signal.SIGKILL)]
    assert children[0].returncode == 0, 'SIGTERM interrupted the owned decoder reap'
    try:
        real_waitid(os.P_PID, children[0].pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
    except ChildProcessError:
        pass
    else:
        raise AssertionError('owned decoder reservation was not reaped')
    assert len(terminations) == (2 if initial_signal == signal.SIGTERM else 1)
    assert signal.pthread_sigmask(signal.SIG_BLOCK, set()) == original_mask
    assert len(list(pathlib.Path('/proc/self/fd').iterdir())) == descriptors
    assert hashlib.sha256(archive.read_bytes()).digest() == original
    assert not list(archive.parent.glob('package-decode-*'))
    print('retained decoder reaped before pending SIGTERM; originals and descriptors unchanged')
finally:
    subprocess.Popen, os.waitid, os.killpg = real_spawn, real_waitid, real_killpg
    signal.signal(signal.SIGTERM, previous)
    # The negative case only observes an exited, still-owned decoder. Reap it
    # safely even when an assertion fails; never signal an unowned numeric group.
    for child in children:
        child.wait(timeout=5)
'''
        for initial_signal in (signal.SIGINT, signal.SIGTERM):
            with self.subTest(initial_signal=initial_signal), tempfile.TemporaryDirectory(dir=self.parent) as directory:
                base = pathlib.Path(directory)
                archive = self.public_payload_deb(base, b'\0' * 10240)
                result = subprocess.run([sys.executable, '-I', '-S', '-B', '-c', script,
                                         str(pathlib.Path(self.producer.__file__)), str(archive), str(int(initial_signal))],
                                        stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=10,
                                        env={'PATH': os.defpath, 'LANG': 'C.UTF-8'})
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip(),
                                 'retained decoder reaped before pending SIGTERM; originals and descriptors unchanged')

    def test_interrupt_after_real_waitpid_reap_never_signals_released_group(self):
        # Drive the maintained Popen.wait KeyboardInterrupt path immediately
        # AFTER its real waitpid, before returncode bookkeeping. No decoder
        # result is invented; an unsafe old group-signal attempt is recorded but
        # intercepted before it could address an unrelated/recycled group.
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            base = pathlib.Path(directory)
            archive = self.public_payload_deb(base, b'\0' * 10240)
            root = base / 'root'
            root.mkdir()
            real_spawn, real_try_wait = subprocess.Popen, subprocess.Popen._try_wait
            children, reaped, signals = [], [], []
            interrupted = False

            def observe_spawn(*args, **kwargs):
                child = real_spawn(*args, **kwargs)
                children.append(child)
                return child

            def cancel_after_reap(child, flags):
                nonlocal interrupted
                result = real_try_wait(child, flags)
                if result[0] == child.pid and not interrupted:
                    interrupted = True
                    reaped.append(result)
                    self.assertIsNone(child.returncode)
                    os.kill(os.getpid(), signal.SIGINT)
                return result

            def reject_unowned_group_signal(pid, signum):
                signals.append((pid, signum))
                # Never actually send to a numeric group after verified reaping.

            descriptors = len(list(pathlib.Path('/proc/self/fd').iterdir()))
            with mock.patch.object(subprocess, 'Popen', observe_spawn), \
                    mock.patch.object(real_spawn, '_try_wait', cancel_after_reap), \
                    mock.patch.object(os, 'killpg', reject_unowned_group_signal):
                with self.assertRaises(KeyboardInterrupt):
                    self.producer.extract_deb(archive, root)
            self.assertEqual(len(children), 1)
            self.assertEqual(len(reaped), 1)
            self.assertEqual(reaped[0][0], children[0].pid)
            self.assertTrue(os.WIFEXITED(reaped[0][1]))
            self.assertEqual(os.WEXITSTATUS(reaped[0][1]), 0)
            self.assertEqual(children[0].returncode, 0)
            self.assertEqual(signals, [])
            with self.assertRaises(ChildProcessError):
                os.waitid(os.P_PID, children[0].pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            self.assertEqual(len(list(pathlib.Path('/proc/self/fd').iterdir())), descriptors)
            self.assertEqual(list(root.iterdir()), [])

    def test_decoder_output_is_kernel_bounded_and_all_descriptors_are_closed(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            base = pathlib.Path(directory)
            member = tarfile.TarInfo('public-data')
            member.size = 8192
            payload = member.tobuf(format=tarfile.USTAR_FORMAT) + b'x' * member.size + b'\0' * 1024
            archive = self.public_payload_deb(base, payload)
            root = base / 'root'
            root.mkdir()
            budget = self.producer.PackageExtractionBudget(payload_bytes=4096)
            before = len(list(pathlib.Path('/proc/self/fd').iterdir()))
            with self.assertRaisesRegex(ValueError, 'package payload refused'):
                self.producer.extract_deb(archive, root, budget)
            self.assertEqual(len(list(pathlib.Path('/proc/self/fd').iterdir())), before)
            self.assertEqual(list(root.iterdir()), [])
            self.assertEqual(set(path.name for path in base.iterdir()), {'root', archive.name})
            # Real inherited limits, not a fabricated decoder: the held output
            # never exceeds its smaller admitted cap, including on child failure.
            with tempfile.TemporaryFile(dir=base) as decoded:
                with self.assertRaisesRegex(ValueError, 'package payload refused'):
                    self.producer.decode_package_payload(archive, decoded, 4096)
                self.assertEqual(os.fstat(decoded.fileno()).st_size, 4096)

    def test_cross_package_byte_entry_and_path_quotas_reserve_before_writes(self):
        for limit in ('bytes', 'entries', 'names'):
            with self.subTest(limit=limit), tempfile.TemporaryDirectory(dir=self.parent) as directory:
                base = pathlib.Path(directory)
                member = tarfile.TarInfo('public-quota-file')
                member.mode = 0o600
                member.size = 3
                payload = member.tobuf(format=tarfile.USTAR_FORMAT) + b'xyz' + b'\0' * 509 + b'\0' * 1024
                archive = self.public_payload_deb(base, payload)
                root = base / 'root'
                root.mkdir()
                kwargs = {'total_bytes': 3} if limit == 'bytes' else (
                    {'entries': 1} if limit == 'entries' else {'name_bytes': len(member.name)})
                budget = self.producer.PackageExtractionBudget(**kwargs)
                self.producer.extract_deb(archive, root, budget)
                self.assertEqual((root / member.name).read_bytes(), b'xyz')
                with self.assertRaisesRegex(ValueError, 'aggregate extraction budget refused'):
                    self.producer.extract_deb(archive, root, budget)
                self.assertEqual((root / member.name).read_bytes(), b'xyz')
                self.assertEqual(len(list(root.iterdir())), 1)
        for kwargs in ({'payload_bytes': 512 * 1024 * 1024 + 1}, {'entries': 400001},
                       {'total_bytes': 4 * 1024 * 1024 * 1024 + 1}, {'name_bytes': 64 * 1024 * 1024 + 1}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                self.producer.PackageExtractionBudget(**kwargs)

    def test_bounded_pax_and_gnu_names_preserve_real_file_and_alias_semantics(self):
        for format in (tarfile.PAX_FORMAT, tarfile.GNU_FORMAT):
            with self.subTest(format=format), tempfile.TemporaryDirectory(dir=self.parent) as directory:
                base = pathlib.Path(directory)
                payload = io.BytesIO()
                name = '/'.join(['public-component'] * 10)
                with tarfile.open(fileobj=payload, mode='w', format=format) as stream:
                    member = tarfile.TarInfo(name)
                    member.size = 3
                    member.mode = 0o640
                    stream.addfile(member, io.BytesIO(b'xyz'))
                    alias = tarfile.TarInfo('public-alias')
                    alias.type = tarfile.SYMTYPE
                    alias.linkname = name
                    stream.addfile(alias)
                    hardlink = tarfile.TarInfo('public-hardlink')
                    hardlink.type = tarfile.LNKTYPE
                    hardlink.mode = 0o640  # Hardlink metadata applies to the same inode.
                    hardlink.linkname = name
                    stream.addfile(hardlink)
                archive = self.public_payload_deb(base, payload.getvalue())
                root = base / 'root'
                root.mkdir()
                self.producer.extract_deb(archive, root)
                self.assertEqual((root / name).read_bytes(), b'xyz')
                self.assertEqual((root / name).stat().st_mode & 0o777, 0o640)
                self.assertEqual((root / 'public-alias').read_bytes(), b'xyz')
                self.assertEqual((root / 'public-hardlink').stat().st_ino, (root / name).stat().st_ino)
                self.producer.extract_deb(archive, root)  # Real streamed collision validation.
                self.assertEqual((root / name).read_bytes(), b'xyz')

    def test_supported_old_gnu_sparse_file_is_retained_without_dense_input(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            base = pathlib.Path(directory)
            member = tarfile.TarInfo('sparse-public-canary')
            member.type = tarfile.GNUTYPE_SPARSE
            member.mode = 0o600
            member.size = 1
            header = bytearray(member.tobuf(format=tarfile.GNU_FORMAT))
            header[386:398] = tarfile.itn(9, 12)
            header[398:410] = tarfile.itn(1, 12)
            header[483:495] = tarfile.itn(10, 12)
            header[148:156] = b' ' * 8
            header[148:156] = bytes('%06o\0 ' % sum(header), 'ascii')
            archive = self.public_payload_deb(base, bytes(header) + b'x' + b'\0' * 511 + b'\0' * 1024)
            root = base / 'root'
            root.mkdir()
            self.producer.extract_deb(archive, root)
            self.assertEqual((root / member.name).read_bytes(), b'\0' * 9 + b'x')

    def test_supported_pax_sparse_maps_preserve_bytes_and_refuse_extent_mismatch(self):
        for format in ('0.1', '1.0', 'mismatched'):
            with self.subTest(format=format), tempfile.TemporaryDirectory(dir=self.parent) as directory:
                base = pathlib.Path(directory)
                member = tarfile.TarInfo('pax-sparse-public')
                member.mode = 0o600
                if format == '1.0':
                    member.size = 513
                    member.pax_headers = {'GNU.sparse.major': '1', 'GNU.sparse.minor': '0',
                                          'GNU.sparse.realsize': '10'}
                    data = b'1\n9\n1\n' + b'\0' * 506 + b'x' + b'\0' * 511
                else:
                    member.size = 1
                    member.pax_headers = {'GNU.sparse.map': '9,1' if format == '0.1' else '9,2',
                                          'GNU.sparse.realsize': '10'}
                    data = b'x' + b'\0' * 511
                archive = self.public_payload_deb(base, member.tobuf(format=tarfile.PAX_FORMAT) + data + b'\0' * 1024)
                root = base / 'root'
                root.mkdir()
                if format == 'mismatched':
                    with self.assertRaisesRegex(ValueError, 'archive sparse extent refused'):
                        self.producer.extract_deb(archive, root)
                    self.assertEqual(list(root.iterdir()), [])
                else:
                    self.producer.extract_deb(archive, root)
                    self.assertEqual((root / member.name).read_bytes(), b'\0' * 9 + b'x')

    def test_streamed_collision_fits_bounded_parent_memory_and_preserves_mismatches(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            base = pathlib.Path(directory)
            member = tarfile.TarInfo('large-public-collision')
            member.size = 64 * 1024 * 1024
            packed = io.BytesIO()
            with gzip.GzipFile(fileobj=packed, mode='wb', compresslevel=1, mtime=0) as output:
                output.write(member.tobuf(format=tarfile.USTAR_FORMAT))
                chunk = b'x' * (1024 * 1024)
                for _ in range(64):
                    output.write(chunk)
                output.write(b'\0' * 1024)
            archive = base / 'large-inert.deb'
            with archive.open('xb') as output:
                output.write(b'!<arch>\n')
                for name, data in [('debian-binary', b'2.0\n'),
                                   ('control.tar.gz', gzip.compress(b'\0' * 10240, mtime=0)),
                                   ('data.tar.gz', packed.getvalue())]:
                    fields = ((name + '/').ljust(16) + '0'.ljust(12) + '0'.ljust(6)
                              + '0'.ljust(6) + '100600'.ljust(8) + str(len(data)).ljust(10) + '`\n')
                    output.write(fields.encode())
                    output.write(data)
                    if len(data) % 2:
                        output.write(b'\n')
            root = base / 'root'
            root.mkdir()
            script = '''
import importlib.util, pathlib, resource, sys
resource.setrlimit(resource.RLIMIT_AS, (64 * 1024 * 1024, 64 * 1024 * 1024))
spec = importlib.util.spec_from_file_location('producer', sys.argv[1])
producer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(producer)
archive, root = map(pathlib.Path, sys.argv[2:])
producer.extract_deb(archive, root)
producer.extract_deb(archive, root)
path = root / 'large-public-collision'
with path.open('r+b') as output:
    output.seek(-1, 2)
    output.write(b'y')
try:
    producer.extract_deb(archive, root)
except ValueError as error:
    if 'file collision refused' not in str(error):
        raise
else:
    raise AssertionError('changed collision accepted')
with path.open('rb') as output:
    output.seek(-1, 2)
    assert output.read(1) == b'y'
'''
            result = subprocess.run([sys.executable, '-I', '-S', '-B', '-c', script,
                                     str(ROOT / '.github/scripts/prepare-qemu-gssapi-fixture.py'), str(archive), str(root)],
                                    text=True, capture_output=True, timeout=30,
                                    env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(set(path.name for path in base.iterdir()), {'root', archive.name})

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
        # Include the extracted signed-record helper: all three queries still
        # require the same explicit startup root, rather than dropping one check.
        queries = [node for node in ast.walk(module) if isinstance(node, ast.Call)
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

    def test_retention_partial_directory_acquisition_closes_real_predecessors(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            base = pathlib.Path(directory)
            (base / 'cache').mkdir()
            # A real O_DIRECTORY failure after base and cache were opened.
            (base / 'cache/archives').write_bytes(b'public non-directory canary')
            data = b'public retention canary; no provider authenticity'
            packages = {'canary': {'archiveSha256': hashlib.sha256(data).hexdigest(),
                                   'archiveSizeBytes': len(data)}}
            descriptors = len(list(pathlib.Path('/proc/self/fd').iterdir()))
            with self.assertRaisesRegex(ValueError, 'public package archive custody refused'):
                self.producer.retain_public_inputs(base, 'provision-complete', {'packages': packages})
            self.assertEqual(len(list(pathlib.Path('/proc/self/fd').iterdir())), descriptors)
            self.assertFalse((base / 'public-evidence/provision-complete.json').exists())

    def test_retention_real_partial_write_failure_closes_fds_without_completion_record(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            base = pathlib.Path(directory)
            cache = base / 'cache/archives'
            cache.mkdir(parents=True)
            data = b'public kernel-limited copy canary; no provider authenticity'
            original = cache / 'canary.deb'
            original.write_bytes(data)
            script = '''
import errno, hashlib, importlib.util, pathlib, resource, sys
spec = importlib.util.spec_from_file_location('actual_producer', sys.argv[1])
producer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(producer)
base = pathlib.Path(sys.argv[2])
original = base / 'cache/archives/canary.deb'
data = original.read_bytes()
digest = hashlib.sha256(data).hexdigest()
packages = {'canary': {'archiveSha256': digest, 'archiveSizeBytes': len(data)}}
fd_count = len(list(pathlib.Path('/proc/self/fd').iterdir()))
resource.setrlimit(resource.RLIMIT_FSIZE, (4, 4))
try:
    producer.retain_public_inputs(base, 'provision-complete', {'packages': packages})
except ValueError as error:
    assert str(error) == 'public package archive custody refused'
    assert isinstance(error.__cause__, OSError)
    assert error.__cause__.errno == errno.EFBIG  # Actual retained write/flush.
else:
    raise AssertionError('kernel-limited retention write unexpectedly succeeded')
assert len(list(pathlib.Path('/proc/self/fd').iterdir())) == fd_count
assert original.read_bytes() == data
assert not (base / 'public-evidence/provision-complete.json').exists()
retained = base / 'public-evidence/package-archives' / (digest + '.deb')
assert retained.is_file() and retained.stat().st_size == 4
print('actual partial copy refused; descriptors closed; completion record absent')
'''
            result = subprocess.run([sys.executable, '-I', '-S', '-B', '-c', script,
                                     str(ROOT / '.github/scripts/prepare-qemu-gssapi-fixture.py'), str(base)],
                                    capture_output=True, text=True, timeout=10,
                                    env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('actual partial copy refused', result.stdout)
            self.assertEqual(original.read_bytes(), data)

    def test_source_decoder_uses_hashed_original_after_real_path_replacement(self):
        original = ROOT / 'crates/target/qemu-full-fixture-source/qemu-9.2.0.tar.xz'
        self.assertTrue(original.is_file() and not original.is_symlink(), 'verified source prerequisite required')
        decoder_open = self.producer.lzma.open
        with decoder_open(original, 'rb') as decoded:
            expected_header = decoded.read(512)
        self.assertEqual(expected_header[:11], b'qemu-9.2.0/')
        for interruption in ('borrower-error', 'sigint'):
            with self.subTest(interruption=interruption), tempfile.TemporaryDirectory(dir=self.parent) as directory:
                base = pathlib.Path(directory)
                archive = base / original.name
                shutil.copyfile(original, archive)
                before = len(list(pathlib.Path('/proc/self/fd').iterdir()))
                borrowed = []
                replacement = self.producer.lzma.compress(b'unauthenticated named replacement')

                def replace_then_decode(file, mode):
                    # This is the real decoder boundary, AFTER the production
                    # digest. No digest, source identity or decoded byte is faked.
                    archive.rename(base / 'held-original.tar.xz')
                    archive.write_bytes(replacement)
                    if hasattr(file, 'fileno'):
                        borrowed.append(file.fileno())
                    with decoder_open(file, mode) as decoded:
                        self.assertEqual(decoded.read(512), expected_header,
                                         'decoder consumed the unhashed named replacement')
                    if interruption == 'sigint':
                        signal.raise_signal(signal.SIGINT)
                    raise RuntimeError('inert source decoder borrower stopped')

                error = KeyboardInterrupt if interruption == 'sigint' else RuntimeError
                with mock.patch.object(self.producer.lzma, 'open', side_effect=replace_then_decode):
                    with self.assertRaises(error):
                        self.producer.extract_source(archive, base / 'qemu-9.2.0')
                self.assertEqual(len(borrowed), 1, 'decoder must borrow the held original descriptor')
                with self.assertRaises(OSError) as closed:
                    os.fstat(borrowed[0])
                self.assertEqual(closed.exception.errno, errno.EBADF)
                self.assertEqual(len(list(pathlib.Path('/proc/self/fd').iterdir())), before)
                self.assertEqual(archive.read_bytes(), replacement)
                self.assertEqual(self.producer.sha(base / 'held-original.tar.xz'), self.producer.QEMU_SHA256)
                self.assertFalse((base / 'qemu-9.2.0').exists())

    def test_source_acquisition_interrupts_close_actual_fd_and_restore_mask(self):
        # Each isolated child changes only its own signal state and opens an
        # inert public file. No decoder, pinned identity or provider is faked.
        script = '''
import errno, importlib.util, os, pathlib, signal, sys
spec = importlib.util.spec_from_file_location('actual_producer', sys.argv[1])
producer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(producer)
archive = pathlib.Path(sys.argv[2])
case = sys.argv[3]
mask = signal.pthread_sigmask(signal.SIG_BLOCK, set())
before = len(list(pathlib.Path('/proc/self/fd').iterdir()))
original_open, original_mask = os.open, signal.pthread_sigmask
opened, blocked, terminated = [], [], []
def terminate(signum, frame):
    terminated.append(signum)
    raise SystemExit(128 + signum)
previous_handler = signal.signal(signal.SIGTERM, terminate)
def acquire_then_interrupt(path, flags, *args, **kwargs):
    descriptor = original_open(path, flags, *args, **kwargs)
    if pathlib.Path(path) == archive:
        opened.append(descriptor)
        os.kill(os.getpid(), signal.SIGINT if case == 'sigint' else signal.SIGTERM)
    return descriptor
def mutate_then_fail(how, values):
    result = original_mask(how, values)
    if how == signal.SIG_BLOCK and values == {signal.SIGINT, signal.SIGTERM}:
        blocked.append(original_mask(signal.SIG_BLOCK, set()))
        raise KeyboardInterrupt('after actual native mask mutation')
    return result
try:
    if case == 'mask-failure':
        signal.pthread_sigmask = mutate_then_fail
    else:
        os.open = acquire_then_interrupt
    try:
        with producer.opened_qemu_archive(archive):
            raise AssertionError('interrupted acquisition admitted input')
    except KeyboardInterrupt:
        assert case in ('sigint', 'mask-failure')
    except SystemExit as error:
        assert case == 'sigterm' and error.code == 128 + signal.SIGTERM
    else:
        raise AssertionError('interruption did not propagate')
finally:
    os.open, signal.pthread_sigmask = original_open, original_mask
    signal.signal(signal.SIGTERM, previous_handler)
assert len(opened) == (0 if case == 'mask-failure' else 1)
if case == 'mask-failure':
    assert len(blocked) == 1 and {signal.SIGINT, signal.SIGTERM}.issubset(blocked[0])
assert terminated == ([signal.SIGTERM] if case == 'sigterm' else [])
for descriptor in opened:
    try:
        os.fstat(descriptor)
    except OSError as error:
        assert error.errno == errno.EBADF
    else:
        raise AssertionError('real original descriptor leaked')
assert len(list(pathlib.Path('/proc/self/fd').iterdir())) == before
assert original_mask(signal.SIG_BLOCK, set()) == mask
assert archive.read_bytes() == b'inert public open-only input'
print('actual acquisition interrupted; original FD closed and caller mask restored')
'''
        for case in ('sigint', 'sigterm', 'mask-failure'):
            with self.subTest(case=case), tempfile.TemporaryDirectory(dir=self.parent) as directory:
                archive = pathlib.Path(directory) / 'public-open-only-input'
                archive.write_bytes(b'inert public open-only input')
                result = subprocess.run(
                    [sys.executable, '-I', '-S', '-B', '-c', script,
                     str(ROOT / '.github/scripts/prepare-qemu-gssapi-fixture.py'), str(archive), case],
                    capture_output=True, text=True, timeout=10,
                    env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'})
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn('original FD closed and caller mask restored', result.stdout)
                self.assertEqual(archive.read_bytes(), b'inert public open-only input')

    def test_source_fifo_refuses_without_waiting_for_a_writer_or_starting_decoder(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            base = pathlib.Path(directory)
            archive = base / 'qemu-9.2.0.tar.xz'
            os.mkfifo(archive, mode=0o600)  # No writer exists at any point.
            script = '''
import importlib.util, os, pathlib, sys
spec = importlib.util.spec_from_file_location('actual_producer', sys.argv[1])
producer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(producer)
archive = pathlib.Path(sys.argv[2])
before = len(list(pathlib.Path('/proc/self/fd').iterdir()))
try:
    producer.extract_source(archive, archive.parent / 'qemu-9.2.0')
except ValueError as error:
    assert str(error) == 'source-pinned QEMU archive input refused'
else:
    raise AssertionError('source FIFO admitted')
assert len(list(pathlib.Path('/proc/self/fd').iterdir())) == before
assert pathlib.Path('/proc/self/task/' + str(os.getpid()) + '/children').read_text().strip() == ''
assert not (archive.parent / 'qemu-9.2.0').exists()
print('source FIFO refused; no descriptor or decoder child remains')
'''
            child = subprocess.Popen([sys.executable, '-I', '-S', '-B', '-c', script,
                                      str(ROOT / '.github/scripts/prepare-qemu-gssapi-fixture.py'), str(archive)],
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                     env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'})
            try:
                output, error = child.communicate(timeout=3)
            finally:
                if child.poll() is None:
                    child.kill()
                child.wait(timeout=3)
                child.stdout.close()
                child.stderr.close()
            self.assertEqual(child.returncode, 0, error)
            self.assertIn('source FIFO refused', output)
            self.assertFalse(pathlib.Path('/proc/' + str(child.pid)).exists())
            self.assertEqual(set(path.name for path in base.iterdir()), {archive.name})

    def test_source_original_exact_bytes_digest_and_actual_writer_drift_are_checked(self):
        original = ROOT / 'crates/target/qemu-full-fixture-source/qemu-9.2.0.tar.xz'
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            base = pathlib.Path(directory)
            archive = base / original.name
            before = len(list(pathlib.Path('/proc/self/fd').iterdir()))
            archive.write_bytes(b'public wrong-size input')
            with self.assertRaisesRegex(ValueError, 'QEMU archive input refused'):
                with self.producer.opened_qemu_archive(archive):
                    self.fail('wrong-sized source admitted')
            with archive.open('wb') as output:
                output.truncate(135188800)  # Real sparse file, not a decoder result.
            with self.assertRaisesRegex(ValueError, 'QEMU archive digest refused'):
                with self.producer.opened_qemu_archive(archive):
                    self.fail('wrong-digest exact-sized source admitted')
            shutil.copyfile(original, archive)
            with self.assertRaisesRegex(ValueError, 'QEMU archive changed'):
                with self.producer.opened_qemu_archive(archive) as held:
                    descriptor = held.fileno()
                    with self.producer.lzma.open(held, 'rb') as decoded:
                        self.assertEqual(decoded.read(11), b'qemu-9.2.0/')
                    with archive.open('r+b') as writer:
                        writer.write(b'changed original')
            with self.assertRaises(OSError) as closed:
                os.fstat(descriptor)
            self.assertEqual(closed.exception.errno, errno.EBADF)
            self.assertEqual(len(list(pathlib.Path('/proc/self/fd').iterdir())), before)
            self.assertEqual(self.producer.sha(original), self.producer.QEMU_SHA256)
            self.assertFalse((base / 'qemu-9.2.0').exists())

    def test_source_buffered_borrower_cannot_release_the_owned_original_fd(self):
        original = ROOT / 'crates/target/qemu-full-fixture-source/qemu-9.2.0.tar.xz'
        before = len(list(pathlib.Path('/proc/self/fd').iterdir()))
        with self.producer.opened_qemu_archive(original) as held:
            descriptor = held.fileno()
            self.assertEqual(os.fstat(descriptor).st_size, 135188800)
            held.close()
            self.assertEqual(os.fstat(descriptor).st_size, 135188800)
        with self.assertRaises(OSError) as closed:
            os.fstat(descriptor)
        self.assertEqual(closed.exception.errno, errno.EBADF)
        self.assertEqual(len(list(pathlib.Path('/proc/self/fd').iterdir())), before)

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
