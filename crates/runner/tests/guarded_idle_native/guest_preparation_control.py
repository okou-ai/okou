"""Test-only same-operation owner of a canonical Guest preparation helper."""

import argparse
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import time

from file_open_permission import FileOpenPermission, original_metadata
from file_residency import metadata, require
from guest_permission_control import Controller, serve_owned

HELPER = "/usr/local/bin/guest-agent"
ARGV = [HELPER, "prepare-for-reuse"]
PAYLOADS = {"current": b"original current\n", "retained": b"original retained\n",
            "stale": b"original stale\n"}
LIMIT = 65536


def cgroup(pid):
    value = Path(f"/proc/{pid}/cgroup").read_text()
    require(re.fullmatch(r"0::/vm0-exec/[^/\n]+/workload\n", value) is not None,
            "producer is not in a supervised workload leaf")
    return value


class Preparation(Controller):
    """Own a direct helper child; the enclosing accepted exec owns this process."""

    def __init__(self, parent):
        # The regular-file base initializer would arm the wrong kind of gate.
        # Initialize its complete ownership state with the directory original.
        self.original = self.executable = self.gate = None
        self.event = self.child = None
        self.stdout = self.stderr = None
        self.observed = self.decided = self.joined = False
        self.retirement = None
        self.parent = Path(parent)
        self.request = json.dumps({"currentRuntimeDir": str(self.parent / "current"),
                                   "retainedRuntimeDir": str(self.parent / "retained")},
                                  separators=(",", ":")).encode()
        self.workload = cgroup("self")
        try:
            for name, payload in PAYLOADS.items():
                directory = self.parent / name
                directory.mkdir(mode=0o700)
                with (directory / "payload").open("xb") as stream:
                    stream.write(payload)
            self.original = os.open(self.parent, os.O_RDONLY | os.O_DIRECTORY
                                    | os.O_NOFOLLOW | os.O_CLOEXEC)
            self.executable = os.open(HELPER, os.O_RDONLY | os.O_CLOEXEC)
            self.identity = original_metadata(self.original, directory=True)
            self.executable_identity = metadata(self.executable)
            self.stdout, self.stderr = tempfile.TemporaryFile(), tempfile.TemporaryFile()
            self.gate = FileOpenPermission(
                self.original, (self.identity["device"], self.identity["inode"]), directory=True)
        except BaseException:
            self.close()
            raise

    def payloads(self):
        # No open of the marked parent itself: marks do not cover children.
        return {name: (self.parent / name / "payload").read_bytes().hex()
                for name in PAYLOADS if (self.parent / name).exists()}

    def status(self):
        self.gate.fileno()
        require(not self.decided, "status is only valid before decision")
        if self.event is not None:
            self.gate.check_pending_producer(self.event)
        require(original_metadata(self.original, directory=True) == self.identity,
                "original runtime parent changed")
        payloads = self.payloads()
        require(payloads == {name: data.hex() for name, data in PAYLOADS.items()},
                "original fixture bytes changed before decision")
        return {"held": self.event is not None, "original": self.identity,
                "payloads": payloads, "workload": self.workload,
                "observed_ns": time.monotonic_ns()}

    def observe(self):
        require(self.child is not None and not self.joined, "helper has not started")
        value = super().observe()
        require(self.event.pid == self.child.pid, "permission producer is not the owned child")
        require(value["argv"] == ARGV, "canonical preparation argv changed")
        require(cgroup(self.child.pid) == self.workload, "helper escaped the owned workload")
        self.gate.check_pending_producer(self.event)
        return value | {"workload": self.workload, "child_pid": self.child.pid}

    def join(self):
        require(self.child is not None and not self.joined, "no unjoined helper")
        status = self.child.wait(timeout=20)
        joined_ns = time.monotonic_ns()
        self.joined = True
        outputs = []
        for stream in (self.stdout, self.stderr):
            stream.seek(0)
            data = stream.read(LIMIT + 1)
            require(len(data) <= LIMIT, "helper output exceeded capture bound")
            outputs.append(data.hex())
        return {"helper_joined": True, "returncode": status, "stdout_hex": outputs[0],
                "stderr_hex": outputs[1], "request_hex": self.request.hex(),
                "payloads": self.payloads(), "child_pid": self.child.pid,
                "joined_ns": joined_ns}

    def command(self, value):
        op = value.get("op")
        if op == "start":
            require(set(value) == {"op"} and self.child is None, "invalid/repeated start")
            started_ns = time.monotonic_ns()
            self.child = subprocess.Popen(ARGV, stdin=subprocess.PIPE,
                                          stdout=self.stdout, stderr=self.stderr)
            # The small exact request precedes the helper's first directory open.
            try:
                self.child.stdin.write(self.request)
                self.child.stdin.flush()
            finally:
                self.child.stdin.close()
            return {"child_pid": self.child.pid, "request_hex": self.request.hex(),
                    "argv": ARGV, "workload": self.workload,
                    "started_ns": started_ns}, False
        if op == "join":
            require(set(value) == {"op"} and self.decided, "join requires explicit decision")
            return self.join(), False
        if op == "decide":
            # Stop future opens before releasing this one. The real helper may
            # reopen its directory during cleanup; those are not this boundary.
            # Accepted events remain owned and receive their explicit decision.
            require(set(value) == {"op", "event_id", "allow"}
                    and type(value["event_id"]) is int and value["event_id"] == 1
                    and type(value["allow"]) is bool and self.event is not None
                    and not self.decided, "invalid preparation decision")
            self.gate.stop_accepting()
            result, _ = super().command(value)
            self.retirement = self.gate.close()
            self.gate = None
            return result | {"retirement": self.retirement}, False
        if op == "retire":
            require(self.joined, "retirement requires a joined helper")
            require(set(value) == {"op"} and self.decided, "invalid retirement")
            self.close()
            return self.retirement | {"helper_joined": True,
                                      "originals_closed": True}, True
        return super().command(value)

    def close(self):
        result = None
        if self.gate is not None:
            result = self.gate.close()
            self.gate = None
        # Explicit gate denial/unmark precedes waiting even on EOF/error. A
        # timeout propagates as failed unresolved ownership; never kill-to-pass.
        joined = None
        try:
            if self.child is not None and not self.joined:
                joined = self.join()
        finally:
            # Preserve originals/captures while an accepted child is unresolved.
            if self.child is None or self.joined:
                super().close()
                for name in ("stdout", "stderr"):
                    stream = getattr(self, name)
                    if stream is not None:
                        setattr(self, name, None)
                        stream.close()
        if joined is not None:
            # Failure-only fixture audit on the already-owned exec capture. The
            # control stream still fails; this never acknowledges successful retirement.
            print(json.dumps({"schema": "guest-preparation-failure-cleanup-v1",
                              "retirement": result, "joined": joined,
                              "originals_closed": True}, separators=(",", ":")), flush=True)
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--nonce", required=True)
    parser.add_argument("--parent", type=Path, required=True)
    args = parser.parse_args()
    require(os.geteuid() == 0, "Guest preparation controller requires root")
    require(1024 <= args.port <= 65535 and args.port != 52000, "invalid private port")
    require(args.parent.is_absolute(), "runtime parent must be absolute")
    with socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM) as stream:
        stream.settimeout(30)
        stream.connect((2, args.port))
        serve_owned(stream, args.nonce, Preparation(args.parent))


if __name__ == "__main__":
    main()
