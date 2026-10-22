"""Synthetic original-record/CLI consumers, not native Guest execution proof."""

import copy
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest

from file_open_permission import EVENT, FAN_OPEN_PERM
import guest_preparation_control_report as report

SOURCE, NONCE = "a" * 40, "1" * 32


def framed(value):
    data = json.dumps(value, separators=(",", ":")).encode()
    return struct.pack("!I", len(data)) + data


def sized(value, width=4):
    return len(value).to_bytes(width, "big") + value


def packet(kind, data):
    return sized(bytes([kind]) + (7).to_bytes(4, "big") + data)


def original(allow):
    identity = dict(device=11, inode=37, uid=0, size=4096, links=2, mtime_ns=1, ctime_ns=1)
    directory = identity | {"file_type": 0o40000}
    executable = identity | {"inode": 38, "size": 1024, "links": 1}
    workload, pid = "0::/vm0-exec/owned/workload\n", 123
    argv = ["/usr/local/bin/guest-agent", "prepare-for-reuse"]
    parent = f"/tmp/preparation-{NONCE}/runtime"
    stdin = json.dumps({"currentRuntimeDir": parent + "/current",
                        "retainedRuntimeDir": parent + "/retained"}).encode()
    event = {"raw_hex": EVENT.pack(32, 3, 0, 24, FAN_OPEN_PERM, 7, pid, 4, 0, 8, 8).hex(),
             "device": 11, "inode": 37, "pid": pid, "observed_ns": 20}
    cleanup = {"started_ns": 41, "completed_ns": 42, "denied": [], "mark_removed": True,
               "group_closed": True, "original_duplicate_closed": True, "observation_failed": False}
    stdout = json.dumps({"before": {"availableBytes": 1000000, "availableInodes": 1000},
                         "after": {"availableBytes": 1000000, "availableInodes": 1000},
                         "removedEntries": 1}).encode() if allow else b""
    stderr = b"" if allow else b"runtime cleanup failed: Operation not permitted (os error 1)\n"
    answers = [
        {"child_pid": pid, "request_hex": stdin.hex(), "argv": argv,
         "workload": workload, "started_ns": 10},
        {"event_id": 1, "event": event, "executable": executable, "argv": argv,
         "workload": workload, "child_pid": pid},
        {"held": True, "original": directory, "payloads": report.PAYLOADS,
         "workload": workload, "observed_ns": 30},
        {"event": event, "decision": "allow" if allow else "deny", "response_started_ns": 40,
         "response_completed_ns": 41, "event_descriptors_closed": True, "retirement": cleanup},
        {"helper_joined": True, "returncode": 0 if allow else 4, "stdout_hex": stdout.hex(),
         "stderr_hex": stderr.hex(), "request_hex": stdin.hex(), "child_pid": pid,
         "payloads": {key: value for key, value in report.PAYLOADS.items()
                      if key != "stale" or not allow}, "joined_ns": 50},
        cleanup | {"helper_joined": True, "originals_closed": True},
    ]
    hello = {"nonce": NONCE, "id": 0, "ready": True, "uid": 0, "original": directory,
             "executable": executable, "kernel": "synthetic-reader-input"}
    commands = [{"op": "start"}, {"op": "observe"}, {"op": "status"},
                {"op": "decide", "event_id": 1, "allow": allow},
                {"op": "join"}, {"op": "retire"}]
    files = {"control-0-response.bin": framed(hello), "helper-stdin.json": stdin,
             "helper-stdout.bin": stdout, "helper-stderr.bin": stderr}
    for index, (command, answer) in enumerate(zip(commands, answers, strict=True), 1):
        files[f"control-{index}-request.bin"] = framed({"nonce": NONCE, "id": index,
                                                      "command": command})
        files[f"control-{index}-response.bin"] = framed({"nonce": NONCE, "id": index,
                                                       "result": answer})
    command = (f"exec python3 -B /tmp/preparation-{NONCE}/guest_preparation_control.py "
               f"--port 52010 --nonce {NONCE} --parent {parent}").encode()
    data = (b"\0\0\0" + (90000).to_bytes(4, "big") + b"\x01" + sized(command)
            + bytes(4) + sized(b"native-guest-preparation", 2)
            + b"\x01"+(4096).to_bytes(4, "big")+b"\x01"+(8192).to_bytes(4, "big")
            + b"\0\x01" + bytes(6))
    files["exec-request.bin"] = packet(0x0b, data)
    files["exec-terminal.bin"] = packet(0x0e, bytes(9) + b"\x01\0" + sized(b"")
                                        + b"\x01\0" + sized(b"") + bytes(2))
    files["controller-terminal.txt"] = (
        b"Exited { exit_code: 0 } Captured { truncated: false } "
        b"Captured { truncated: false } stream_overflowed: false")
    files["qualification.json"] = json.dumps({
        "schema": "native-guest-preparation-component-v1", "source_commit": SOURCE,
        "allow": allow, "nonce": NONCE, "controller_joined": True, "exchange_joined": True,
        "connection_joined": True, "vm_containment_only": True,
        "runner_final_exec_established": False, "cancellation_custody_established": False,
        "saving_lease_cleanup_established": False}).encode()
    return files


def write_capture(directory, files):
    for name, raw in files.items():
        (directory / name).write_bytes(raw)
    manifest = json.dumps({"source_commit": SOURCE,
                           "files": {name: hashlib.sha256(raw).hexdigest()
                                     for name, raw in files.items()}}).encode()
    (directory / "capture.json").write_bytes(manifest)
    return hashlib.sha256(manifest).hexdigest()


class ReaderTests(unittest.TestCase):
    def test_original_allow_and_deny_records_through_real_cli(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            for allow in (True, False):
                digest = write_capture(directory, original(allow))
                result = subprocess.run(
                    [sys.executable, "-B", str(Path(report.__file__)), str(directory),
                     "--expected-source", SOURCE, "--expected-capture-sha256", digest],
                    capture_output=True, timeout=10, check=False)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout)["allow"], allow)

    def test_foreign_authority_incomplete_join_and_changed_phase_are_rejected(self):
        mutations = [
            ("control-2-response.bin", lambda v: v["result"]["event"].update(pid=124)),
            ("control-2-response.bin", lambda v: v["result"]["executable"].update(inode=38.0)),
            ("control-2-response.bin", lambda v: v["result"].update(workload="0::/foreign\n")),
            ("control-5-response.bin", lambda v: v["result"].update(helper_joined=False)),
            ("control-5-response.bin", lambda v: v["result"].update(joined_ns=15)),
            ("control-5-response.bin", lambda v: v["result"]["payloads"].update(current="00")),
            ("control-6-response.bin", lambda v: v["result"].update(originals_closed=1)),
            ("qualification.json", lambda v: v.update(runner_final_exec_established=True)),
            ("qualification.json", lambda v: v.update(source_commit="b" * 40)),
        ]
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            for name, mutate in mutations:
                files = copy.deepcopy(original(True))
                value = json.loads(files[name][4:] if name.endswith(".bin") else files[name])
                mutate(value)
                files[name] = framed(value) if name.endswith(".bin") else json.dumps(value).encode()
                with self.subTest(file=name):
                    digest = write_capture(directory, files)
                    with self.assertRaises(ValueError):
                        report.validate(directory, SOURCE, digest)

    def test_real_cli_rejects_changed_original_terminal_and_capture_binding(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            files = original(True)
            digest = write_capture(directory, files)
            (directory / "exec-terminal.bin").write_bytes(files["exec-terminal.bin"] + b"x")
            for capture in (digest, "0" * 64):
                result = subprocess.run(
                    [sys.executable, "-B", str(Path(report.__file__)), str(directory),
                     "--expected-source", SOURCE, "--expected-capture-sha256", capture],
                    capture_output=True, timeout=10, check=False)
                self.assertEqual(result.returncode, 1, result.stderr)


if __name__ == "__main__":
    unittest.main()
