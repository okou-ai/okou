"""Test-only Guest permission owner on a stream independent of normal RPCs."""

import argparse
from dataclasses import asdict
import json
import os
from pathlib import Path
import re
import socket
import struct
import time

from file_open_permission import FileOpenPermission
from file_residency import metadata, require

MAX_FRAME = 16384


def exact(stream, size, deadline):
    data = bytearray()
    while len(data) < size:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("permission control frame deadline exceeded")
        stream.settimeout(remaining)
        part = stream.recv(size - len(data))
        if not part:
            raise EOFError("permission control stream ended")
        data.extend(part)
    return bytes(data)


def receive(stream):
    deadline = time.monotonic() + 30
    size = struct.unpack("!I", exact(stream, 4, deadline))[0]
    require(0 < size <= MAX_FRAME, "invalid control frame length")
    # Duplicate JSON keys are ambiguous authority, even when values agree.
    def pairs(rows):
        value = {}
        for key, item in rows:
            require(key not in value, "duplicate JSON key")
            value[key] = item
        return value

    value = json.loads(exact(stream, size, deadline), object_pairs_hook=pairs)
    require(type(value) is dict, "control frame must be an object")
    return value


def send(stream, value):
    data = json.dumps(value, separators=(",", ":"), allow_nan=False).encode()
    require(0 < len(data) <= MAX_FRAME, "oversized control response")
    # Any partial write is uncertain. The caller never retries this response.
    stream.settimeout(30)
    stream.sendall(struct.pack("!I", len(data)) + data)


class Controller:
    """One task retains the gate and its actual event until explicit disposal."""

    def __init__(self, original, executable):
        self.original = self.executable = self.gate = None
        self.event = None
        self.observed = self.decided = False
        try:
            self.original = os.open(original, os.O_RDONLY | os.O_CLOEXEC)
            self.executable = os.open(executable, os.O_RDONLY | os.O_CLOEXEC)
            self.identity = metadata(self.original)
            self.executable_identity = metadata(self.executable)
            require(self.identity["size"] <= 4096, "oversized original timezone file")
            self.payload = os.pread(self.original, 4097, 0)
            self.gate = FileOpenPermission(
                self.original, (self.identity["device"], self.identity["inode"])
            )
        except BaseException:
            self.close()
            raise

    def status(self):
        self.gate.fileno()
        if self.event is not None:
            self.gate.check_pending_producer(self.event)
        require(not self.decided, "status is only valid before decision")
        require(metadata(self.original) == self.identity, "original metadata changed")
        require(os.pread(self.original, 4097, 0) == self.payload, "original bytes changed")
        return {"held": self.event is not None, "original": self.identity,
                "payload_hex": self.payload.hex(), "observed_ns": time.monotonic_ns()}

    def observe(self):
        require(not self.observed, "event already observed")
        self.observed = True
        self.event = self.gate.receive()
        self.gate.check_pending_producer(self.event)
        # The kernel event PIDFD pins/checks live task identity around this
        # descriptor inspection. Numeric PID lookup alone is never readiness.
        fd = os.open(f"/proc/{self.event.pid}/exe", os.O_RDONLY | os.O_CLOEXEC)
        try:
            actual = metadata(fd)
            require(actual == self.executable_identity, "foreign permission producer")
            with open(f"/proc/{self.event.pid}/cmdline", "rb") as stream:
                command = stream.read(4097)
            require(len(command) <= 4096 and command.endswith(b"\0"),
                    "invalid producer argv")
            argv = [part.decode("utf-8") for part in command[:-1].split(b"\0")]
            self.gate.check_pending_producer(self.event)
        finally:
            os.close(fd)
        self.status()
        return {"event_id": 1, "event": asdict(self.event), "executable": actual,
                "argv": argv}

    def command(self, value):
        op = value.get("op")
        if op == "observe":
            require(set(value) == {"op"}, "unexpected observe fields")
            return self.observe(), False
        if op == "status":
            require(set(value) == {"op"}, "unexpected status fields")
            return self.status(), False
        if op == "decide":
            require(set(value) == {"op", "event_id", "allow"}, "invalid decision fields")
            require(type(value["event_id"]) is int and value["event_id"] == 1,
                    "foreign event identity")
            require(self.event is not None and not self.decided, "no pending event")
            result = self.gate.decide(self.event, value["allow"])
            self.decided = True
            self.event = None
            return result, False
        if op == "retire":
            require(set(value) == {"op"}, "unexpected retirement fields")
            require(self.decided, "successful retirement requires an explicit decision")
            return self.close(), True
        raise ValueError("unknown permission command")

    def close(self):
        result = None
        if self.gate is not None:
            result = self.gate.close()
            self.gate = None
        for name in ("original", "executable"):
            fd = getattr(self, name)
            if fd is not None:
                setattr(self, name, None)  # an uncertain close is never retried
                os.close(fd)
        return result


def serve(stream, nonce, original, executable):
    require(re.fullmatch(r"[0-9a-f]{32}", nonce) is not None, "invalid invocation nonce")
    stream.settimeout(30)
    owner = Controller(original, executable)
    try:
        send(stream, {"nonce": nonce, "id": 0, "ready": True, "uid": os.geteuid(),
                      "original": owner.identity, "executable": owner.executable_identity,
                      "kernel": os.uname().release})
        for sequence in range(1, 9):
            request = receive(stream)
            require(set(request) == {"nonce", "id", "command"}, "invalid envelope fields")
            require(request["nonce"] == nonce and type(request["id"]) is int
                    and request["id"] == sequence, "foreign or repeated control request")
            require(type(request["command"]) is dict, "invalid command")
            result, complete = owner.command(request["command"])
            send(stream, {"nonce": nonce, "id": sequence, "result": result})
            if complete:
                return
        raise ValueError("permission control command bound exceeded")
    finally:
        # EOF/error cleanup explicitly denies observed/queued opens where
        # possible. It is failure containment, never successful retirement.
        owner.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--nonce", required=True)
    args = parser.parse_args()
    require(os.geteuid() == 0, "native Guest controller requires root")
    require(1024 <= args.port <= 65535 and args.port != 52000, "invalid private port")
    with socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM) as stream:
        stream.settimeout(30)
        stream.connect((2, args.port))
        serve(stream, args.nonce, Path("/etc/timezone"), Path("/sbin/guest-state-restore"))


if __name__ == "__main__":
    main()
