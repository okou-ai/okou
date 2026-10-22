"""Protocol failures and actual kernel/producer custody, never VM substitutes."""

import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
import unittest

import guest_permission_control as control

NONCE = "1" * 32
SERVER = """import socket, sys
from guest_permission_control import serve
serve(socket.socket(fileno=int(sys.argv[1])), sys.argv[2], sys.argv[3], sys.executable)
"""


class ProtocolTests(unittest.TestCase):
    def test_owned_server_retires_its_descriptor_on_setup_or_nonce_failure(self):
        class Owner:
            def __init__(self, fd):
                self.fd = fd

            def close(self):
                os.close(self.fd)

        for failure in ("closed stream", "invalid nonce"):
            with self.subTest(failure=failure):
                fd, writer = os.pipe()
                left, right = socket.socketpair()
                with left, right:
                    if failure == "closed stream":
                        right.close()
                    try:
                        with self.assertRaises((OSError, ValueError)):
                            control.serve_owned(right, "invalid", Owner(fd))
                        with self.assertRaises(OSError):
                            os.fstat(fd)
                    finally:
                        os.close(writer)

    def test_rejects_invalid_and_ambiguous_frames(self):
        values = [b"", b"x", b"[]", b'{"id":1,"id":1}', b"null", b"\xff"]
        for value in values:
            with self.subTest(value=value):
                # Every peer is explicitly closed, including truncated bodies.
                left, right = socket.socketpair()
                with left, right:
                    left.sendall(struct.pack("!I", len(value)) + value)
                    left.shutdown(socket.SHUT_WR)
                    with self.assertRaises((ValueError, UnicodeError, EOFError)):
                        control.receive(right)

    def test_rejects_oversized_and_truncated_frames_without_waiting_for_body(self):
        for raw in (struct.pack("!I", control.MAX_FRAME + 1), b"\x00\x00",
                    struct.pack("!I", 4) + b"{}"):
            with self.subTest(raw=raw):
                left, right = socket.socketpair()
                with left, right:
                    left.sendall(raw)
                    left.shutdown(socket.SHUT_WR)
                    with self.assertRaises((ValueError, EOFError)):
                        control.receive(right)

@unittest.skipUnless(os.environ.get("OKOU_TEST_OPEN_PERMISSION_KERNEL") == "1",
                     "requires explicit root FAN_OPEN_PERM/PIDFD qualification")
class KernelTests(unittest.TestCase):
    def exercise(self, outcome):
        self.assertEqual(os.geteuid(), 0)
        children = []
        with tempfile.TemporaryDirectory() as directory:
            original = Path(directory) / "timezone"
            original.write_bytes(b"owned timezone\n")
            host, guest = socket.socketpair()
            with host, guest:
                env = dict(os.environ, PYTHONPATH=str(Path(control.__file__).parent),
                           PYTHONDONTWRITEBYTECODE="1")
                server = subprocess.Popen(
                    [sys.executable, "-B", "-c", SERVER,
                     str(guest.fileno()), NONCE, str(original)],
                    pass_fds=(guest.fileno(),), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    env=env,
                )
                children.append(server)
                guest.close()
                host.settimeout(10)
                try:
                    hello = control.receive(host)
                    self.assertTrue(hello["ready"])
                    producer = subprocess.Popen(
                        [sys.executable, "-B", "-c",
                         "import pathlib,sys; print(pathlib.Path(sys.argv[1]).read_text())",
                         str(original)], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    )
                    children.append(producer)

                    def command(sequence, value):
                        control.send(host, {"nonce": NONCE, "id": sequence, "command": value})
                        reply = control.receive(host)
                        self.assertEqual((reply["nonce"], reply["id"]), (NONCE, sequence))
                        return reply["result"]

                    event = command(1, {"op": "observe"})
                    self.assertEqual(event["event"]["pid"], producer.pid)
                    self.assertIsNone(producer.poll())
                    self.assertTrue(command(2, {"op": "status"})["held"])
                    if outcome == "eof":
                        host.shutdown(socket.SHUT_RDWR)
                    elif outcome == "duplicate":
                        control.send(host, {"nonce": NONCE, "id": 2,
                                            "command": {"op": "decide", "event_id": 1, "allow": True}})
                    elif outcome == "foreign":
                        control.send(host, {"nonce": NONCE, "id": 3,
                                            "command": {"op": "decide", "event_id": 2, "allow": True}})
                    elif outcome == "nonce":
                        control.send(host, {"nonce": "2" * 32, "id": 3,
                                            "command": {"op": "decide", "event_id": 1, "allow": True}})
                    elif outcome == "exited":
                        # A failed original producer must invalidate later live
                        # identity checks; a replacement numeric PID is no proof.
                        producer.kill()
                        producer.communicate(timeout=10)
                        control.send(host, {"nonce": NONCE, "id": 3,
                                            "command": {"op": "status"}})
                    else:
                        result = command(3, {"op": "decide", "event_id": 1,
                                             "allow": outcome == "allow"})
                        self.assertTrue(result["event_descriptors_closed"])
                        self.assertTrue(command(4, {"op": "retire"})["group_closed"])
                    stdout, stderr = server.communicate(timeout=10)
                    self.assertFalse(stdout)
                    self.assertEqual(server.returncode == 0, outcome in ("allow", "deny"), stderr)
                    stdout, stderr = producer.communicate(timeout=10)
                    if outcome == "allow":
                        self.assertEqual((producer.returncode, stdout, stderr),
                                         (0, b"owned timezone\n\n", b""))
                    else:
                        self.assertNotEqual(producer.returncode, 0)
                    self.assertEqual(original.read_bytes(), b"owned timezone\n")
                finally:
                    host.close()
                    # Failure containment cannot turn a failed assertion into
                    # success. Always reap every fixture-owned producer.
                    for child in children:
                        if child.poll() is None:
                            child.kill()
                        child.communicate(timeout=10)

    def test_allow(self):
        self.exercise("allow")

    def test_deny(self):
        self.exercise("deny")

    def test_eof_denies_pending_event_and_fails_controller(self):
        self.exercise("eof")

    def test_duplicate_request_denies_pending_event(self):
        self.exercise("duplicate")

    def test_foreign_event_denies_pending_event(self):
        self.exercise("foreign")

    def test_dead_original_producer_fails_identity_check(self):
        self.exercise("exited")

    def test_foreign_nonce_denies_pending_event(self):
        self.exercise("nonce")


if __name__ == "__main__":
    unittest.main()
