#!/usr/bin/env python3
"""Bounded Linux measurement of a command and descendants created by this fixture.

This is calibration tooling, never production admission or a VM-exit/relief oracle.
"""

import argparse
import ctypes
import json
import math
import os
import selectors
import signal
import stat
import subprocess
import sys
import time
from pathlib import Path

MAX_PROC_BYTES = 65536
MAX_CHILDREN = 256
MAX_SAMPLES = 12000
MAX_LOG_BYTES = 16 * 1024 * 1024
MAX_U64 = (1 << 64) - 1


class FixtureCancelled(Exception):
    """Cancellation must not be swallowed as EINTR by selector polling."""


def bounded_read(path, limit=MAX_PROC_BYTES):
    with Path(path).open("rb") as handle:
        content = handle.read(limit + 1)
    if len(content) > limit:
        raise ValueError(f"oversized input: {path}")
    return content


def available_bytes(content):
    values = []
    for line in content.decode("ascii").splitlines():
        if line.startswith("MemAvailable:"):
            fields = line.removeprefix("MemAvailable:").split()
            if (
                len(fields) != 2
                or fields[1] != "kB"
                or not fields[0].isascii()
                or not fields[0].isdecimal()
            ):
                raise ValueError("malformed MemAvailable")
            value = int(fields[0]) * 1024
            if value > MAX_U64:
                raise ValueError("MemAvailable overflow")
            values.append(value)
    if len(values) != 1:
        raise ValueError("missing or duplicate MemAvailable")
    return values[0]


def process_identity(pid):
    try:
        content = bounded_read(f"/proc/{pid}/stat", 4096).decode("ascii")
    except FileNotFoundError:
        return None
    fields = content.rsplit(")", 1)[1].split()
    return int(fields[19]), fields[0]


def child_pids(pid):
    # Runner spawns subprocesses from Tokio workers, not necessarily the thread
    # group leader. Reading only task/<pid>/children misses those owned VMs.
    children = set()
    try:
        with os.scandir(f"/proc/{pid}/task") as tasks:
            for count, task in enumerate(tasks, start=1):
                if count > MAX_CHILDREN:
                    raise ValueError("fixture thread bound exceeded")
                try:
                    content = bounded_read(Path(task.path) / "children", 4096)
                except FileNotFoundError:
                    continue
                children.update(int(value) for value in content.split())
                if len(children) > MAX_CHILDREN:
                    raise ValueError("fixture child bound exceeded")
    except FileNotFoundError:
        return []
    return sorted(children)


def discover_owned(owned):
    # This standalone subreaper has no pre-existing children. Do not attach to a
    # supplied PID or scan another Runner's VM inventory.
    pending = child_pids(os.getpid())
    seen = set()
    while pending:
        pid = pending.pop()
        if pid in seen:
            continue
        seen.add(pid)
        if len(seen) > MAX_CHILDREN or len(owned) > MAX_CHILDREN:
            raise ValueError("fixture descendant bound exceeded")
        identity = process_identity(pid)
        if identity is None:
            continue
        generation = identity[0]
        if pid in owned and owned[pid] != generation:
            raise ValueError("owned PID generation changed")
        owned[pid] = generation
        children = child_pids(pid)
        if process_identity(pid) == identity:
            pending.extend(children)


def residency(pid, generation):
    before = process_identity(pid)
    if before is None or before[0] != generation or before[1] == "Z":
        return None
    try:
        content = bounded_read(f"/proc/{pid}/smaps_rollup").decode("ascii")
    except (FileNotFoundError, ProcessLookupError, PermissionError):
        return None
    values = {}
    for line in content.splitlines():
        key, separator, rest = line.partition(":")
        if separator and key in ("Rss", "Pss"):
            fields = rest.split()
            if len(fields) != 2 or fields[1] != "kB" or not fields[0].isdecimal():
                raise ValueError("invalid fixture residency units")
            values[key.lower() + "_bytes"] = int(fields[0]) * 1024
    after = process_identity(pid)
    if after is None or after[0] != generation or after[1] == "Z":
        return None
    if len(values) != 2:
        return None
    return {"pid": pid, "start_ticks": generation, **values}


def signal_owned(owned, sig):
    for pid, generation in list(owned.items()):
        before = process_identity(pid)
        if before is None or before[0] != generation or before[1] == "Z":
            continue
        try:
            fd = os.pidfd_open(pid)
        except ProcessLookupError:
            continue
        try:
            after = process_identity(pid)
            if after is not None and after[0] == generation:
                signal.pidfd_send_signal(fd, sig)
        except ProcessLookupError:
            pass
        finally:
            os.close(fd)


def reap_adopted(driver_pid, waits):
    for pid in child_pids(os.getpid()):
        if pid == driver_pid:
            continue
        try:
            waited, status = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            continue
        if waited:
            waits.append({"pid": waited, "wait_status": status})


def create_output(path):
    path = Path(os.path.abspath(path))
    for part in [path, *path.parents]:
        if part.is_symlink():
            raise ValueError("fixture output path contains a symlink")
    for parent in path.parents:
        mode = parent.stat().st_mode
        if mode & (stat.S_IWGRP | stat.S_IWOTH) and not mode & stat.S_ISVTX:
            raise ValueError("fixture output parent is replaceable by another owner")
    # Exclusive creation; never reuse or recursively remove another run's files.
    path.mkdir(mode=0o700)
    return path


def validate_limits(duration, interval, grace, log_bytes, minimum_available):
    if not all(math.isfinite(value) for value in (duration, interval, grace)):
        raise ValueError("fixture timing limits must be finite")
    if not 0 < duration <= 600 or not 0.05 <= interval <= 5 or not 0.1 <= grace <= 120:
        raise ValueError("fixture timing limits outside supported bounds")
    if math.ceil(duration / interval) + 2 > MAX_SAMPLES:
        raise ValueError("fixture sample bound exceeded")
    if not 1 <= log_bytes <= MAX_LOG_BYTES or not 0 < minimum_available <= MAX_U64:
        raise ValueError("invalid fixture output/headroom bounds")


def collect(
    output,
    command,
    metadata,
    *,
    duration,
    interval,
    grace,
    log_bytes,
    minimum_available,
):
    validate_limits(duration, interval, grace, log_bytes, minimum_available)
    if not command:
        raise ValueError("a disposable owned fixture command is required")
    if (
        sys.platform != "linux"
        or not hasattr(os, "pidfd_open")
        or not hasattr(signal, "pidfd_send_signal")
    ):
        raise ValueError("fixture requires Linux pidfd support")
    if child_pids(os.getpid()):
        raise ValueError("collector must run in a process without existing children")
    initial = available_bytes(bounded_read("/proc/meminfo"))
    if initial < minimum_available:
        raise ValueError("insufficient preflight host headroom; fixture not launched")
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER, fixture process only.
        raise OSError(ctypes.get_errno(), "set fixture child subreaper")
    output = create_output(output)
    owned = {}
    waits = []
    errors = []
    cleanup_errors = []
    timed_out = False
    pressure_stop = False
    cleanup_intervened = False
    truncated = False
    samples = 0
    residency_incomplete_samples = 0
    started = time.monotonic_ns()
    started_unix_ns = time.time_ns()
    driver = None
    selector = selectors.DefaultSelector()
    logs = {}
    log_sizes = {"stdout": 0, "stderr": 0}
    try:
        with (output / "samples.jsonl").open("x", encoding="utf-8") as sample_file:
            for name in ("stdout", "stderr"):
                logs[name] = (output / f"{name}.log").open("xb", buffering=0)
            driver = subprocess.Popen(
                command,
                cwd=output,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                start_new_session=True,
                # A fixture must not inherit provider tokens, API overrides or
                # personal credential/config directories from its caller.
                env={
                    "PATH": os.defpath,
                    "HOME": str(output),
                    "TMPDIR": str(output),
                    "LANG": "C.UTF-8",
                },
            )
            for name, stream in (("stdout", driver.stdout), ("stderr", driver.stderr)):
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, selectors.EVENT_READ, name)
            next_sample = time.monotonic()
            deadline = next_sample + duration
            while True:
                now = time.monotonic()
                discover_owned(owned)
                if now >= next_sample:
                    read_start = time.monotonic_ns()
                    available = available_bytes(bounded_read("/proc/meminfo"))
                    host_read_duration = time.monotonic_ns() - read_start
                    measurements = []
                    for pid, generation in owned.items():
                        value = residency(pid, generation)
                        if value is None:
                            value = {
                                "pid": pid,
                                "start_ticks": generation,
                                "rss_bytes": None,
                                "pss_bytes": None,
                            }
                        measurements.append(value)
                    if any(value["rss_bytes"] is None for value in measurements):
                        residency_incomplete_samples += 1
                    sample = {
                        "monotonic_ns": read_start,
                        "unix_ns": time.time_ns(),
                        "read_duration_ns": host_read_duration,
                        "sample_age_ns": time.monotonic_ns() - read_start,
                        "mem_available_bytes": available,
                        "processes": measurements,
                    }
                    sample_file.write(json.dumps(sample, separators=(",", ":")) + "\n")
                    sample_file.flush()
                    samples += 1
                    if available < minimum_available:
                        pressure_stop = True
                        break
                    if samples >= MAX_SAMPLES:
                        raise ValueError("fixture sample bound exceeded")
                    next_sample = (
                        now + interval
                    )  # Coalesce delayed sampling; never replay a backlog.
                reap_adopted(driver.pid, waits)
                code = driver.poll()
                if code is not None:
                    break
                if now >= deadline:
                    timed_out = True
                    break
                for key, _ in selector.select(
                    min(interval, max(0, next_sample - time.monotonic()))
                ):
                    chunk = os.read(key.fd, MAX_PROC_BYTES)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    remaining = log_bytes - log_sizes[key.data]
                    logs[key.data].write(chunk[:remaining])
                    log_sizes[key.data] += min(len(chunk), remaining)
                    truncated |= len(chunk) > remaining
    except (OSError, ValueError, FixtureCancelled) as error:
        errors.append(str(error))
    finally:
        # Discover adopted children before any signals. pidfds plus generation
        # checks prevent a recycled PID from turning cleanup into cross-owner kill.
        if driver is not None:
            try:
                discover_owned(owned)
                if timed_out or pressure_stop or errors:
                    # Give the driver its saving/export grace before signalling
                    # its VMs or accepted-I/O children directly.
                    generation = owned.get(driver.pid)
                    if generation is not None and driver.poll() is None:
                        signal_owned({driver.pid: generation}, signal.SIGTERM)
                cleanup_deadline = time.monotonic() + grace
                while time.monotonic() < cleanup_deadline:
                    discover_owned(owned)
                    driver.poll()
                    reap_adopted(driver.pid, waits)
                    if not child_pids(os.getpid()):
                        break
                    time.sleep(0.02)
                if child_pids(os.getpid()):
                    cleanup_intervened = True
                    discover_owned(owned)
                    signal_owned(owned, signal.SIGTERM)
                    descendant_deadline = time.monotonic() + grace
                    while (
                        child_pids(os.getpid())
                        and time.monotonic() < descendant_deadline
                    ):
                        driver.poll()
                        reap_adopted(driver.pid, waits)
                        time.sleep(0.02)
                    if child_pids(os.getpid()):
                        discover_owned(owned)
                        signal_owned(owned, signal.SIGKILL)
                driver.wait(timeout=grace)
                reap_deadline = time.monotonic() + grace
                while child_pids(os.getpid()) and time.monotonic() < reap_deadline:
                    discover_owned(owned)
                    signal_owned(owned, signal.SIGKILL)
                    reap_adopted(driver.pid, waits)
                    time.sleep(0.02)
                # Drain pipes after positive waits, retaining the same byte bounds.
                for key in list(selector.get_map().values()):
                    while True:
                        try:
                            chunk = os.read(key.fd, MAX_PROC_BYTES)
                        except BlockingIOError:
                            break
                        if not chunk:
                            break
                        remaining = log_bytes - log_sizes[key.data]
                        logs[key.data].write(chunk[:remaining])
                        log_sizes[key.data] += min(len(chunk), remaining)
                        truncated |= len(chunk) > remaining
            except (
                OSError,
                ValueError,
                FixtureCancelled,
                subprocess.TimeoutExpired,
            ) as error:
                cleanup_errors.append(str(error))
                errors.append(f"cleanup uncertain: {error}")
        selector.close()
        for handle in logs.values():
            handle.close()
        if driver is not None:
            for stream in (driver.stdout, driver.stderr):
                stream.close()
    remaining_children = child_pids(os.getpid())
    joined = driver is not None and driver.returncode is not None
    report = {
        "format": "runner-memory-calibration-v1",
        "metadata": metadata,
        "started_monotonic_ns": started,
        "started_unix_ns": started_unix_ns,
        "duration_ns": time.monotonic_ns() - started,
        "samples": samples,
        "residency_incomplete_samples": residency_incomplete_samples,
        "initial_available_bytes": initial,
        "driver_exit_code": driver.returncode if driver is not None else None,
        "driver_wait_confirmed": joined,
        "adopted_child_waits": waits,
        "remaining_children": remaining_children,
        "cleanup_confirmed": joined and not remaining_children and not cleanup_errors,
        "cleanup_intervened": cleanup_intervened,
        "timed_out": timed_out,
        "headroom_stop": pressure_stop,
        "logs_truncated": truncated,
        "errors": errors,
        "calibrated": False,
        "native_vm_exit_confirmed": False,
        "coverage": "fixture-command-only; phase/VM/continuation proof requires driver evidence",
    }
    report["success"] = (
        report["cleanup_confirmed"]
        and driver.returncode == 0
        and not timed_out
        and not pressure_stop
        and not errors
        and not cleanup_intervened
    )
    with (output / "report.json").open("x", encoding="utf-8") as report_file:
        report_file.write(json.dumps(report, indent=2) + "\n")
    return report


def interrupted(signum, _frame):
    raise FixtureCancelled(f"fixture interrupted by signal {signum}")


def main():
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument(
        "--metadata",
        required=True,
        help="JSON artifact/profile/scenario evidence; no secrets",
    )
    parser.add_argument("--duration-seconds", type=float, default=300)
    parser.add_argument("--interval-seconds", type=float, default=0.1)
    parser.add_argument("--cleanup-grace-seconds", type=float, default=30)
    parser.add_argument("--max-log-bytes", type=int, default=1024 * 1024)
    parser.add_argument(
        "--minimum-available-mib",
        type=int,
        required=True,
        help="fixture-only safety floor, not Runner policy",
    )
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    try:
        metadata = json.loads(bounded_read(args.metadata))
        if not isinstance(metadata, dict):
            raise TypeError("metadata must be a JSON object")
        report = collect(
            args.output,
            command,
            metadata,
            duration=args.duration_seconds,
            interval=args.interval_seconds,
            grace=args.cleanup_grace_seconds,
            log_bytes=args.max_log_bytes,
            minimum_available=args.minimum_available_mib * 1024 * 1024,
        )
    except (OSError, ValueError, TypeError, FixtureCancelled) as error:
        print(f"fixture not completed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(report))
    return 0 if report["success"] else 1


if __name__ == "__main__":
    sys.exit(main())
