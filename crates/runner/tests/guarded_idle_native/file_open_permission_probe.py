"""Bounded real-kernel qualification with private synthetic files/producers."""

import argparse
import hashlib
import json
import os
import re
import select
import subprocess
import sys
import time
import uuid
from pathlib import Path

from file_open_permission import FileOpenPermission
from file_residency import metadata, require, task_identity

PAYLOAD = b"owned original open-permission qualification\n"
CLAIMS = {
    "native_guest_executed": False,
    "canonical_helper_acceptance_established": False,
    "lifecycle_cancellation_established": False,
    "cold_snapshot_established": False,
    "required_saving_established": False,
    "full_lease_cleanup_established": False,
    "original_cleanup_io_established": False,
    "physical_memory_credit": False,
    "production_protection_established": False,
}
PRODUCER = """import errno,json,pathlib,sys
try:
    data=pathlib.Path(sys.argv[1]).read_bytes()
except OSError as error:
    print(json.dumps({'errno':error.errno}),flush=True)
    sys.exit(23)
print(json.dumps({'payload_hex':data.hex()}),flush=True)
"""


def producer(path):
    return subprocess.Popen(
        [sys.executable, "-B", "-c", PRODUCER, str(path)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def join(child):
    stdout, stderr = child.communicate(timeout=10)
    require(len(stdout) <= 1024 and not stderr, "unexpected producer output")
    return {
        "pid": child.pid,
        "exit": child.returncode,
        "stdout_hex": stdout.hex(),
        "stderr_hex": stderr.hex(),
        "joined_ns": time.monotonic_ns(),
    }


def qualify(output, source):
    require(
        re.fullmatch(r"[0-9a-f]{40}", source) is not None, "expected full source SHA"
    )
    require(output.is_absolute(), "qualification directory must be absolute")
    output.mkdir(mode=0o700)  # exclusive: never reuse a previous observation
    original = output / "original"
    fd = None
    record = {
        "schema": "original-open-permission-v1",
        "source_commit": source,
        "run_id": str(uuid.uuid4()),
        "host": {
            "boot_id": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
            "kernel": os.uname().release,
        },
        "controller": {
            "pid": os.getpid(),
            "task": list(task_identity()),
            "uid": os.geteuid(),
        },
        "invocation": [
            sys.executable,
            str(Path(__file__).resolve()),
            "--output-dir",
            str(output),
            "--source-commit",
            source,
        ],
        "started_ns": time.monotonic_ns(),
        "payload_sha256": hashlib.sha256(PAYLOAD).hexdigest(),
        "cases": [],
        "claims": CLAIMS.copy(),
        "error": None,
        "complete": False,
    }
    active = None
    gate = None
    try:
        fd = os.open(original, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
        require(
            os.write(fd, PAYLOAD) == len(PAYLOAD), "short qualification payload write"
        )
        os.fsync(fd)
        record["original"] = metadata(fd)
        identity = record["original"]["device"], record["original"]["inode"]
        for decision in ("allow", "deny", "retire"):
            case = {"kind": decision, "started_ns": time.monotonic_ns()}
            record["cases"].append(case)
            gate = FileOpenPermission(fd, identity)
            active = producer(original)
            case["producer_pid"] = active.pid
            if decision == "retire":
                poller = select.poll()
                poller.register(gate.fileno(), select.POLLIN)
                require(
                    poller.poll(10_000) == [(gate.fileno(), select.POLLIN)],
                    "queued permission observation timed out",
                )
                case["cleanup"] = gate.close()
                gate = None
                require(
                    len(case["cleanup"]["denied"]) == 1,
                    "retirement did not explicitly deny original opener",
                )
                case["disposition"] = case["cleanup"]["denied"][0]
            else:
                event = gate.receive()
                require(
                    event.pid == active.pid and active.poll() is None,
                    "foreign or completed producer",
                )
                case["disposition"] = gate.decide(event, decision == "allow")
            case["producer"] = join(active)
            active = None
            expected = (
                {"payload_hex": PAYLOAD.hex()} if decision == "allow" else {"errno": 1}
            )
            require(
                json.loads(bytes.fromhex(case["producer"]["stdout_hex"])) == expected,
                "unexpected actual producer result",
            )
            require(
                case["producer"]["exit"] == (0 if decision == "allow" else 23),
                "unexpected producer exit",
            )
            if gate is not None:
                case["cleanup"] = gate.close()
                gate = None
            case["completed_ns"] = time.monotonic_ns()
        require(
            metadata(fd) == record["original"]
            and os.pread(fd, len(PAYLOAD) + 1, 0) == PAYLOAD,
            "original payload changed",
        )
        os.close(fd)
        fd = None
        record["borrowed_original_closed"] = True
        record["complete"] = True
    except BaseException as error:  # noqa: BLE001 - own children even on observer unwind
        record["error"] = f"{type(error).__name__}: {error}"
        # Failure containment is diagnostic only, never successful qualification.
        if gate is not None:
            try:
                record["failure_retirement"] = gate.close()
            except BaseException as cleanup_error:  # noqa: BLE001 - preserve failed retirement
                record["failure_retirement_error"] = str(cleanup_error)
        if active is not None:
            try:
                record["failure_producer"] = join(active)
            except BaseException as join_error:  # noqa: BLE001 - contain only the owned child
                record["failure_join_error"] = str(join_error)
                active.kill()  # only this newly owned synthetic process
                active.communicate(timeout=10)
                record["failure_intervention"] = True
    finally:
        if fd is not None:
            os.close(fd)
        record["completed_ns"] = time.monotonic_ns()
        raw = (json.dumps(record, sort_keys=True, indent=2) + "\n").encode()
        with (output / "record.json").open("xb") as stream:
            stream.write(raw)
    require(record["complete"] and record["error"] is None, record["error"])
    return hashlib.sha256(raw).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--source-commit", required=True)
    args = parser.parse_args()
    try:
        capture = qualify(args.output_dir, args.source_commit)
    except (OSError, ValueError) as error:
        parser.exit(1, f"qualification failed: {error}\n")
    print(
        json.dumps({"record": str(args.output_dir / "record.json"), "sha256": capture})
    )


if __name__ == "__main__":
    main()
