"""Focused local-probe tests: python3 -m unittest ansible/scripts/test_wss_host_registrar.py"""

import importlib.util
import json
import os
from pathlib import Path
import re
import socket
import tempfile
import threading
import unittest

SCRIPT = Path(__file__).with_name("wss_host_registrar.py")
spec = importlib.util.spec_from_file_location("wss_host_registrar", SCRIPT)
registrar = importlib.util.module_from_spec(spec)
assert spec.loader
spec.loader.exec_module(registrar)
RUNNER_ID = "01234567-89ab-cdef-0123-456789abcdef"


class ProbeTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.socket_dir = Path(self.directory.name)
        self.path = self.socket_dir / f"{RUNNER_ID}.sock"

    def listen(self, *, wrong_id=False, wrong_nonce=False):
        listener = socket.socket(socket.AF_UNIX)
        listener.bind(str(self.path))
        listener.listen(1)
        self.addCleanup(listener.close)
        failures = []

        def serve():
            try:
                connection, _ = listener.accept()
                with connection:
                    request = connection.recv(1024).decode("ascii")
                    nonce = re.search(r"nonce=([0-9a-f]{32})", request).group(1)
                    body = json.dumps({
                        "runnerId": "00000000-0000-0000-0000-000000000000" if wrong_id else RUNNER_ID,
                        "nonce": "0" * 32 if wrong_nonce else nonce,
                    }).encode()
                    connection.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n" + body)
            except Exception as error:
                failures.append(error)

        worker = threading.Thread(target=serve, daemon=True)
        worker.start()
        self.addCleanup(lambda: worker.join(timeout=3))
        return failures

    def test_echoed_identity_and_nonce(self):
        failures = self.listen()
        nonce = registrar.probe_socket(RUNNER_ID, os.getuid(), self.socket_dir)
        self.assertRegex(nonce, r"^[0-9a-f]{32}$")
        self.assertEqual(failures, [])

    def test_wrong_listener_identity(self):
        self.listen(wrong_id=True)
        with self.assertRaisesRegex(ValueError, "identity mismatch"):
            registrar.probe_socket(RUNNER_ID, os.getuid(), self.socket_dir)

    def test_wrong_nonce(self):
        self.listen(wrong_nonce=True)
        with self.assertRaisesRegex(ValueError, "identity mismatch"):
            registrar.probe_socket(RUNNER_ID, os.getuid(), self.socket_dir)

    def test_missing_symlink_and_wrong_owner(self):
        with self.assertRaises(FileNotFoundError):
            registrar.probe_socket(RUNNER_ID, os.getuid(), self.socket_dir)
        self.path.symlink_to(self.socket_dir / "outside")
        with self.assertRaisesRegex(ValueError, "unsafe WSS socket"):
            registrar.probe_socket(RUNNER_ID, os.getuid(), self.socket_dir)
        self.path.unlink()
        self.listen()
        with self.assertRaisesRegex(ValueError, "unsafe WSS socket"):
            registrar.probe_socket(RUNNER_ID, os.getuid() + 1, self.socket_dir)
        self.path.chmod(0o777)
        with self.assertRaisesRegex(ValueError, "unsafe WSS socket"):
            registrar.probe_socket(RUNNER_ID, os.getuid(), self.socket_dir)

    def test_regular_file_and_unresponsive_listener(self):
        self.path.write_text("not a socket")
        with self.assertRaisesRegex(ValueError, "unsafe WSS socket"):
            registrar.probe_socket(RUNNER_ID, os.getuid(), self.socket_dir)
        self.path.unlink()
        listener = socket.socket(socket.AF_UNIX)
        listener.bind(str(self.path))
        listener.listen(1)
        self.addCleanup(listener.close)
        def stall():
            connection, _ = listener.accept()
            with connection:
                connection.recv(1024)
                threading.Event().wait(2.2)
        worker = threading.Thread(target=stall, daemon=True)
        worker.start()
        self.addCleanup(lambda: worker.join(timeout=3))
        with self.assertRaises(socket.timeout):
            registrar.probe_socket(RUNNER_ID, os.getuid(), self.socket_dir)

    def test_invalid_path_and_directory(self):
        with self.assertRaisesRegex(ValueError, "noncanonical"):
            registrar.probe_socket("../etc/passwd", os.getuid(), self.socket_dir)
        self.socket_dir.chmod(0o777)
        with self.assertRaisesRegex(ValueError, "unsafe WSS socket directory"):
            registrar.probe_socket(RUNNER_ID, os.getuid(), self.socket_dir)


if __name__ == "__main__":
    unittest.main()
