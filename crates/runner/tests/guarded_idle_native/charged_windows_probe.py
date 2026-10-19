"""Opt-in bounded kernel qualification of owned charged-memory windows."""

import argparse
import ctypes
import hashlib
import json
import os
import selectors
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path

from charged_windows import FALSE_CLAIMS, MIB, ChargeWindows

SOURCES = (
    "charged_windows.py",
    "charged_windows_probe.py",
    "charged_windows_worker.py",
    "charged_windows_report.py",
)
MINIMUM_AVAILABLE = 8192 * MIB
DURATION_SECONDS = 60


class QualificationCancelled(Exception):
    """Selector/syscall EINTR handling must not swallow cancellation."""


def sha256(content):
    return hashlib.sha256(content).hexdigest()


def available():
    rows = [
        line.split()
        for line in Path("/proc/meminfo").read_text().splitlines()
        if line.startswith("MemAvailable:")
    ]
    if len(rows) != 1 or len(rows[0]) != 3 or rows[0][2] != "kB":
        raise ValueError("missing host availability")
    return int(rows[0][1]) * 1024


def process_identity(pid):
    return int(Path(f"/proc/{pid}/stat").read_bytes().rsplit(b")", 1)[1].split()[19])


def stop(_signum, _frame):
    raise QualificationCancelled("qualification cancelled")


def run(output, parent):
    output = Path(output)
    if not output.is_absolute() or output.parent.resolve(strict=True) != output.parent:
        raise ValueError("output must be new and have a canonical absolute parent")
    output.mkdir(mode=0o700)
    invocation = str(uuid.uuid4())
    sources = {}
    for name in SOURCES:
        content = Path(__file__).with_name(name).read_bytes()
        if len(content) > 65536:
            raise ValueError("oversized original source")
        with (output / name).open("xb") as handle:
            handle.write(content)
        sources[name] = sha256(content)
    source_hash = sha256(
        json.dumps(sources, sort_keys=True, separators=(",", ":")).encode()
    )
    started = time.monotonic_ns()
    result = {
        "format": "owned-charged-window-qualification-v1",
        "invocation": invocation,
        "source_sha256": source_hash,
        "sources": sources,
        "boot_id": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
        "host": {
            "kernel_release": os.uname().release,
            "architecture": os.uname().machine,
            "effective_uid": os.geteuid(),
        },
        "started_monotonic_ns": started,
        "started_unix_ns": time.time_ns(),
        "bounds": {
            "minimum_available_bytes": MINIMUM_AVAILABLE,
            "duration_seconds": DURATION_SECONDS,
            "memory_limit_bytes": 256 * MIB,
            "max_events": 16,
            "max_worker_response_bytes": 4096,
        },
        "parent": str(parent),
        "claims": dict(FALSE_CLAIMS),
        "requests": [],
        "worker": None,
        "worker_ready_monotonic_ns": None,
        "positive_wait_monotonic_ns": None,
        "exit_code": None,
        "wait_confirmed": False,
        "cleanup_intervened": False,
        "cleanup_errors": [],
        "adopted_waits": [],
        "error": None,
    }
    windows = None
    process = None
    pidfd = None
    event_count = 0
    selector = selectors.DefaultSelector()
    pending = bytearray()
    libc = ctypes.CDLL(None, use_errno=True)
    previous_subreaper = ctypes.c_int()
    subreaper_changed = False
    handlers = {
        sig: signal.signal(sig, stop) for sig in (signal.SIGTERM, signal.SIGINT)
    }
    events = (output / "events.jsonl").open("xb", buffering=0)
    stderr = (output / "worker.stderr").open("xb", buffering=0)

    def guard():
        if time.monotonic_ns() - started > DURATION_SECONDS * 10**9:
            raise TimeoutError("qualification deadline exceeded")
        value = available()
        if value < MINIMUM_AVAILABLE:
            raise ValueError("host availability below qualification floor")
        return value

    def emit(row):
        nonlocal event_count
        if event_count >= 16:
            raise ValueError("acquisition event bound exceeded")
        events.write(json.dumps(row, separators=(",", ":")).encode() + b"\n")
        os.fsync(events.fileno())
        event_count += 1

    def receive():
        deadline = min(started + DURATION_SECONDS * 10**9, time.monotonic_ns() + 10**10)
        while True:
            if b"\n" in pending:
                line, _, rest = pending.partition(b"\n")
                pending[:] = rest
                return json.loads(line)
            remaining = (deadline - time.monotonic_ns()) / 10**9
            if remaining <= 0 or not selector.select(remaining):
                raise TimeoutError("owned worker response missing")
            chunk = os.read(process.stdout.fileno(), 4097)
            if not chunk:
                raise ValueError("owned worker exited before response")
            pending.extend(chunk)
            if len(pending) > 4096:
                raise ValueError("owned worker response exceeds bound")

    def command(name):
        guard()
        if process_identity(process.pid) != result["worker"]["start_ticks"]:
            raise ValueError("owned worker generation changed")
        began = time.monotonic_ns()
        process.stdin.write((name + "\n").encode())
        process.stdin.flush()
        response = receive()
        if response.get("completed") != name:
            raise ValueError("owned worker response out of order")
        result["requests"].append(
            {
                "command": name,
                "response": response,
                "started_monotonic_ns": began,
                "completed_monotonic_ns": time.monotonic_ns(),
            }
        )
        return response

    try:
        result["initial_available_bytes"] = guard()
        if Path(f"/proc/self/task/{os.getpid()}/children").read_text().strip():
            raise ValueError("qualification collector must have no existing children")
        if libc.prctl(37, ctypes.byref(previous_subreaper), 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), "cannot read subreaper state")
        if libc.prctl(36, 1, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), "cannot own descendant cleanup")
        subreaper_changed = True
        windows = ChargeWindows(parent, ["outer", "inner"], invocation, emit)
        result["root"] = str(windows.groups[0][0].path)
        result["leaf"] = str(windows.leaf.path)
        result["leaf_identity"] = windows.leaf.identity
        result["parent_identity"] = windows.parent.identity
        windows.begin("outer")
        process = subprocess.Popen(
            windows.command_for_new_child(
                [
                    sys.executable,
                    "-B",
                    str(output / "charged_windows_worker.py"),
                    str(output),
                ]
            ),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=stderr,
            env={
                "PATH": os.defpath,
                "HOME": str(output),
                "TMPDIR": str(output),
                "LANG": "C.UTF-8",
            },
        )
        pidfd = os.pidfd_open(process.pid)
        os.set_blocking(process.stdout.fileno(), False)
        selector.register(process.stdout, selectors.EVENT_READ)
        worker = receive()["ready"]
        if worker["pid"] != process.pid or worker["start_ticks"] != process_identity(
            process.pid
        ):
            raise ValueError("owned worker identity mismatch")
        if worker["cgroup"] != "0::" + result["leaf"].removeprefix("/sys/fs/cgroup"):
            raise ValueError("owned worker was not seeded into the leaf")
        result["worker"] = worker
        result["worker_ready_monotonic_ns"] = time.monotonic_ns()
        command("allocate")
        high = windows.observe("outer")
        command("release")
        low = windows.begin("inner")
        retained = windows.observe("outer")
        if high["peak_bytes"] - low["peak_bytes"] <= 16 * MIB:
            raise ValueError("qualification allocation was not observably released")
        if retained["peak_bytes"] < high["peak_bytes"]:
            raise ValueError("overlapping reset erased the outer peak")
        command("transient")
        transient = windows.end("inner")
        if transient["peak_bytes"] <= low["peak_bytes"] + 8 * MIB:
            raise ValueError("between-observation descendant peak was lost")
        if transient["peak_bytes"] <= transient["current_bytes"] + 8 * MIB:
            raise ValueError(
                "transient peak is not distinguishable from the final point"
            )
        file_response = command("file")
        command("exit")
        process.stdin.close()
        result["exit_code"] = process.wait(timeout=10)
        result["wait_confirmed"] = True
        result["positive_wait_monotonic_ns"] = time.monotonic_ns()
        if result["exit_code"] != 0:
            raise ValueError("owned worker failed")
        final = windows.end("outer")
        if final["file_bytes"] < 64 * MIB:
            raise ValueError("retained post-exit file charge was not observed")
        info = (output / "retained.bin").stat()
        result["retained_file"] = {
            "device": info.st_dev,
            "inode": info.st_ino,
            "bytes": info.st_size,
            "sha256": sha256((output / "retained.bin").read_bytes()),
        }
        if file_response["file"] != {
            k: result["retained_file"][k] for k in ("device", "inode", "bytes")
        }:
            raise ValueError("owned retained file identity changed")
        result["final_available_bytes"] = guard()
    except (
        OSError,
        ValueError,
        KeyError,
        TypeError,
        subprocess.SubprocessError,
        QualificationCancelled,
    ) as error:
        result["error"] = f"{type(error).__name__}: {error}"
    finally:
        if result["error"] is None and sys.exc_info()[0] is not None:
            result["error"] = "unexpected acquisition failure: " + str(
                sys.exc_info()[0].__name__
            )
        # Do not let a repeated cancellation interrupt positive cleanup custody.
        for sig in handlers:
            signal.signal(sig, signal.SIG_IGN)
        if process is not None:
            try:
                if process.poll() is None:
                    result["cleanup_intervened"] = True
                    if pidfd is None:
                        pidfd = os.pidfd_open(process.pid)
                    try:
                        signal.pidfd_send_signal(pidfd, signal.SIGTERM)
                    except ProcessLookupError:
                        pass  # The owned child still requires its positive wait.
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        try:
                            signal.pidfd_send_signal(pidfd, signal.SIGKILL)
                        except ProcessLookupError:
                            pass  # Exit raced escalation; the positive wait is still required.
                        process.wait(timeout=5)
                result["exit_code"] = process.returncode
                result["wait_confirmed"] = process.returncode is not None
            except (OSError, subprocess.TimeoutExpired) as error:
                result["cleanup_errors"].append(
                    {"process": process.pid, "error": str(error)}
                )
            for name, stream in (("stdin", process.stdin), ("stdout", process.stdout)):
                if stream is not None:
                    try:
                        stream.close()
                    except OSError as error:
                        result["cleanup_errors"].append(
                            {
                                "process": process.pid,
                                "stream": name,
                                "error": str(error),
                            }
                        )
        if pidfd is not None:
            os.close(pidfd)
        if subreaper_changed:
            deadline = time.monotonic() + 10
            while True:
                try:
                    pid, status = os.waitpid(-1, os.WNOHANG)
                except ChildProcessError:
                    break
                if pid:
                    result["adopted_waits"].append({"pid": pid, "status": status})
                elif time.monotonic() >= deadline:
                    result["cleanup_errors"].append(
                        {"error": "owned adopted child did not exit"}
                    )
                    break
                else:
                    time.sleep(0.02)
        if windows is not None:
            try:
                result["cleanup_errors"].extend(windows.cleanup())
            except (OSError, ValueError) as error:
                result["cleanup_errors"].append({"error": str(error)})
        result["cleanup_records"] = (
            windows.cleanup_records if windows is not None else []
        )
        if subreaper_changed and libc.prctl(36, previous_subreaper.value, 0, 0, 0) != 0:
            result["cleanup_errors"].append({"error": "cannot restore subreaper state"})
        selector.close()
        events.close()
        stderr.close()
        result["event_count"] = event_count
        result["events_sha256"] = sha256((output / "events.jsonl").read_bytes())
        result["stderr_bytes"] = (output / "worker.stderr").stat().st_size
        result["completed_monotonic_ns"] = time.monotonic_ns()
        result["completed_unix_ns"] = time.time_ns()
        with (output / "capture.json").open("x") as handle:
            json.dump(result, handle, indent=2)
            handle.write("\n")
        for sig, handler in handlers.items():
            signal.signal(sig, handler)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--cgroup-parent", required=True, type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    result = run(args.output, args.cgroup_parent)
    from charged_windows_report import replay

    try:
        report = replay(args.output, result["invocation"], result["source_sha256"])
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(
            json.dumps(
                {
                    "output": str(args.output),
                    "invocation": result["invocation"],
                    "source_sha256": result["source_sha256"],
                    "qualified": False,
                    "error": str(error),
                }
            )
        )
        return 1
    print(json.dumps(report))
    return 0


if __name__ == "__main__":
    sys.exit(main())
