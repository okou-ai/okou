#!/usr/bin/env python3
"""Real filesystem/socket fixtures for the shared host preparer."""

import concurrent.futures
import importlib.util
import os
from pathlib import Path
import socket
import stat
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import yaml

REPO = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location(
    "prepare_wss", REPO / "ansible/scripts/prepare-runner-wss.py"
)
PREPARE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREPARE)


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.assertEqual(os.geteuid(), 0, "native ownership fixtures require root")
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
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            self.assertEqual(list(pool.map(lambda _: self.prepare(), range(16))), [False] * 16)
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
                with self.assertRaises(RuntimeError):
                    self.prepare()
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


class ProvisioningCacheTests(unittest.TestCase):
    def test_hash_hit_still_validates_wss_and_propagates_failure(self):
        action = yaml.safe_load((REPO / ".github/actions/provision/action.yml").read_text())
        command = next(step["run"] for step in action["runs"]["steps"] if step["name"] == "Provision metal hosts")
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            tools = directory / "bin"
            tools.mkdir()
            log = directory / "calls"
            scripts = {
                "git": "#!/bin/sh\nprintf '%s\\n' cached-ansible-hash\n",
                "ssh": "#!/bin/sh\nprintf '%s\\n' cached-ansible-hash\n",
                "ansible-playbook": (
                    "#!/bin/sh\nprintf '%s\\n' \"$*\" >>\"$WSS_FIXTURE_LOG\"\n"
                    "exit \"${WSS_FIXTURE_FAILURE:-0}\"\n"
                ),
            }
            for name, source in scripts.items():
                path = tools / name
                path.write_text(source)
                path.chmod(0o755)
            for failure in [0, 3]:
                with self.subTest(failure=failure):
                    if log.exists():
                        log.unlink()
                    environment = os.environ | {
                        "PATH": f"{tools}:{os.environ['PATH']}",
                        "HOSTS": "fixture-1,fixture-2",
                        "METAL_USER": "fixture",
                        "GRAFANA_CLOUD_API_KEY": "synthetic-fixture",
                        "WSS_FIXTURE_LOG": str(log),
                        "WSS_FIXTURE_FAILURE": str(failure),
                    }
                    result = subprocess.run(
                        ["bash", "-e", "-o", "pipefail", "-c", command],
                        env=environment, capture_output=True, text=True, check=False,
                    )
                    self.assertEqual(result.returncode, failure, result.stderr)
                    self.assertEqual(len(log.read_text().splitlines()), 1)
                    invocation = log.read_text()
                    self.assertIn("-i fixture-1,fixture-2,", invocation)
                    self.assertIn("--tags runner_wss_host", invocation)


if __name__ == "__main__":
    unittest.main()
