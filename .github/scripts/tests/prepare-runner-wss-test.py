#!/usr/bin/env python3
"""Real filesystem/socket fixtures for WSS host provisioning."""

import concurrent.futures
import importlib.util
import os
from pathlib import Path
import socket
import stat
import struct
import tempfile
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location(
    "prepare_wss", REPO / "ansible/scripts/prepare-runner-wss.py"
)
PREPARE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREPARE)


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.assertEqual(os.geteuid(), 0, "native ownership fixtures require root")
        # Match the dedicated CLI entry before any fixture worker is started.
        self.addCleanup(os.umask, os.umask(0o022))
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.root.chmod(0o755)
        (self.root / "var/lib").mkdir(parents=True)
        self.home = self.root / "var/lib/vm0-runner"
        self.namespace = self.home / "wss"

    def prepare(self):
        return PREPARE.prepare(str(self.root), 1)

    def test_idempotent_concurrent_preparation_preserves_connected_socket_and_private_state(self):
        self.assertTrue(self.prepare())
        private = self.home / "control"
        private.mkdir(mode=0o700)
        before_private = private.stat()
        server = socket.socket(socket.AF_UNIX)
        self.addCleanup(server.close)
        endpoint = self.namespace / "live.sock"
        server.bind(str(endpoint))
        server.listen()
        client = socket.socket(socket.AF_UNIX)
        self.addCleanup(client.close)
        client.connect(str(endpoint))
        accepted, _ = server.accept()
        self.addCleanup(accepted.close)
        before = endpoint.stat()
        descriptors_before = len(os.listdir("/proc/self/fd"))
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            self.assertEqual(list(pool.map(lambda _: self.prepare(), range(16))), [False] * 16)
        self.assertEqual(len(os.listdir("/proc/self/fd")), descriptors_before)
        client.sendall(b"healthy")
        self.assertEqual(accepted.recv(7), b"healthy")
        self.assertEqual(endpoint.stat().st_ino, before.st_ino)
        self.assertEqual(endpoint.stat().st_mode, before.st_mode)
        self.assertEqual(private.stat().st_mode, before_private.st_mode)
        self.assertEqual(private.stat().st_ino, before_private.st_ino)
        metadata = self.namespace.stat()
        self.assertEqual((metadata.st_uid, metadata.st_gid), (0, 1))
        self.assertEqual(stat.S_IMODE(metadata.st_mode), 0o710)

    def test_concurrent_first_creation(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: self.prepare(), range(16)))
        self.assertEqual(results.count(True), 1)
        self.assertEqual(stat.S_IMODE(self.home.stat().st_mode), 0o755)
        self.assertEqual(stat.S_IMODE(self.namespace.stat().st_mode), 0o710)

    def test_unsafe_parent_is_preserved(self):
        for parent in [self.root, self.root / "var", self.root / "var/lib"]:
            with self.subTest(parent=parent):
                parent.chmod(0o777)
                with self.assertRaises(RuntimeError):
                    self.prepare()
                self.assertEqual(stat.S_IMODE(parent.stat().st_mode), 0o777)
                self.assertFalse(self.home.exists())
                parent.chmod(0o755)

    def test_conflicting_namespace_is_never_repaired(self):
        self.prepare()
        for mode in [0o755, 0o711, 0o770, 0o2710]:
            with self.subTest(mode=mode):
                self.namespace.chmod(mode)
                descriptors_before = len(os.listdir("/proc/self/fd"))
                with self.assertRaises(RuntimeError):
                    self.prepare()
                self.assertEqual(len(os.listdir("/proc/self/fd")), descriptors_before)
                self.assertEqual(stat.S_IMODE(self.namespace.stat().st_mode), mode)
        self.namespace.chmod(0o710)
        for uid, gid in [(1, 1), (0, 2)]:
            os.chown(self.namespace, uid, gid)
            with self.assertRaises(RuntimeError):
                self.prepare()
            self.assertEqual((self.namespace.stat().st_uid, self.namespace.stat().st_gid), (uid, gid))

    def test_symlinks_and_non_directories_are_preserved(self):
        self.home.mkdir()
        target = self.root / "target"
        target.mkdir(mode=0o700)
        self.namespace.symlink_to(target)
        with self.assertRaises(OSError):
            self.prepare()
        self.assertTrue(self.namespace.is_symlink())
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o700)
        self.namespace.unlink()
        self.namespace.write_text("foreign")
        with self.assertRaises(OSError):
            self.prepare()
        self.assertEqual(self.namespace.read_text(), "foreign")

    def test_access_and_inherited_default_acls_fail_closed(self):
        self.prepare()
        acl = struct.pack("<I", 2) + b"".join(
            struct.pack("<HHI", tag, permissions, qualifier)
            for tag, permissions, qualifier in [
                (1, 7, 0xFFFFFFFF), (2, 1, 1000), (4, 1, 0xFFFFFFFF),
                (16, 1, 0xFFFFFFFF), (32, 0, 0xFFFFFFFF),
            ]
        )
        for directory, name in [
            (self.namespace, "system.posix_acl_access"),
            (self.home, "system.posix_acl_default"),
        ]:
            os.setxattr(directory, name, acl)
            with self.assertRaises(RuntimeError):
                self.prepare()
            self.assertEqual(os.getxattr(directory, name), acl)
            os.removexattr(directory, name)

    def test_missing_group_never_substitutes_another_group(self):
        with patch.object(PREPARE.grp, "getgrnam", side_effect=KeyError), patch.object(
            PREPARE.subprocess, "run"
        ) as create:
            create.return_value.returncode = 1
            with self.assertRaises(RuntimeError):
                PREPARE.prepare(str(self.root))
        self.assertFalse(self.home.exists())
        with self.assertRaises(RuntimeError):
            PREPARE.prepare(str(self.root), 0)


if __name__ == "__main__":
    unittest.main()
