#!/usr/bin/env python3
"""Observe an opt-in Xcode startup without changing the compiler's exit status.

Usage: sample-xcode-startup.py [--delay SECONDS] [--window SECONDS] OUTPUT -- xcodebuild ARGS
macOS provides ps, vm_stat, iostat and sample. Diagnostics stop at Xcode's
command banner or the bounded observation deadline; compilation continues.
OUTPUT must be a new directory. Reports contain process names, not argv/env.
"""

import argparse
import datetime
import json
import os
import select
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

MAX_REPORT_BYTES = 256 * 1024


def terminate(process):
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()


def observe(args):
    args.output.mkdir(mode=0o700)
    started = time.monotonic()
    stop = threading.Event()
    lock = threading.Lock()
    cancelled = []
    summary = {
        "run_id": os.environ.get("GITHUB_RUN_ID"),
        "attempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
        "head": os.environ.get("GITHUB_SHA"),
        "stack_sampling_enabled": not args.no_stack,
        "first_output_seconds": None,
        "command_banner_seconds": None,
    }

    def record(event, **fields):
        item = {
            "event": event,
            "utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "elapsed_seconds": round(time.monotonic() - started, 3),
            **fields,
        }
        with lock, (args.output / "events.jsonl").open("a") as output:
            output.write(json.dumps(item) + "\n")

    def cap_report(path):
        if path.exists() and path.stat().st_size > MAX_REPORT_BYTES:
            marker = b"\n[report truncated]\n"
            with path.open("rb") as source:
                prefix = source.read(MAX_REPORT_BYTES - len(marker))
            path.write_bytes(prefix + marker)
            record("report_truncated", file=path.name)

    def capture(name, command, timeout):
        if stop.is_set() or time.monotonic() >= started + args.window:
            return False
        path = args.output / (name + ".txt")
        deadline = min(started + args.window, time.monotonic() + timeout)
        spawn_started = time.monotonic()
        try:
            with path.open("wb") as output:
                child = subprocess.Popen(
                    command,
                    stdout=output,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                    env=os.environ | {"LC_ALL": "C"},
                )
                try:
                    record(
                        "observation_spawned",
                        tool=command[0],
                        file=path.name,
                        pid=child.pid,
                        spawn_seconds=round(time.monotonic() - spawn_started, 3),
                    )
                    while child.poll() is None:
                        if stop.wait(0.1) or time.monotonic() >= deadline:
                            terminate(child)
                            record(
                                "observation_interrupted",
                                tool=command[0],
                                file=path.name,
                                reason="startup_finished" if stop.is_set() else "deadline",
                                timeout_seconds=timeout,
                            )
                            return False
                    record(
                        "observation",
                        tool=command[0],
                        file=path.name,
                        exit_code=child.returncode,
                    )
                    return child.returncode == 0
                finally:
                    if child.poll() is None:
                        terminate(child)
                    cap_report(path)
        except OSError as error:
            record("observation_unavailable", tool=command[0], error=str(error))
            return False

    def collect(process):
        try:
            round_number = 0
            stack_offsets = iter((args.delay, 60, 120))
            next_stack = next(stack_offsets)
            next_sample = started + args.delay
            deadline = started + args.window
            while not stop.wait(max(0, min(next_sample, deadline) - time.monotonic())):
                if time.monotonic() >= started + args.window:
                    record("observation_window_ended")
                    return
                if process.poll() is not None:
                    return
                round_number += 1
                prefix = f"{round_number:02d}"
                record("snapshot", round=round_number, target_pid=process.pid)
                # Sample the owned compiler first: a saturated host may take
                # many seconds even to enumerate processes or launch a tool.
                if not args.no_stack and time.monotonic() - started >= next_stack:
                    report = args.output / f"{prefix}-xcodebuild-{process.pid}.sample.txt"
                    capture(
                        f"{prefix}-xcodebuild-{process.pid}-sampler",
                        ["sample", str(process.pid), "1", "20", "-file", str(report)],
                        45,
                    )
                    cap_report(report)
                    next_stack = next(stack_offsets, float("inf"))
                capture(
                    prefix + "-processes",
                    ["ps", "-axo", "pid=,ppid=,pcpu=,pmem=,rss=,state=,time=,comm="],
                    20,
                )
                capture(prefix + "-memory", ["vm_stat"], 6)
                # The first iostat row is since boot; the second covers one second.
                capture(prefix + "-disk-cpu", ["iostat", "-w", "1", "-c", "2"], 8)
                # Do not burst-launch missed rounds on an already overloaded host.
                next_sample = time.monotonic() + 15
        except Exception as error:
            # Optional diagnostics cannot turn a compiler failure into a success.
            record("observation_unavailable", tool="collector", error=str(error))
        finally:
            record("observer_stopped")

    def cancel(signum, _frame):
        cancelled.append(signum)
        stop.set()

    original_handlers = {
        value: signal.signal(value, cancel) for value in (signal.SIGTERM, signal.SIGINT)
    }
    process = None
    observer = None
    tail = b""
    try:
        record("observer_ready")
        process = subprocess.Popen(
            args.command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        summary["target_pid"] = process.pid
        record("compiler_started", pid=process.pid)
        observer = threading.Thread(target=collect, args=(process,))
        observer.start()
        output_open = True
        while not cancelled:
            if not output_open:
                if process.poll() is not None:
                    break
                time.sleep(0.1)
                continue
            readable, _, _ = select.select([process.stdout], [], [], 0.1)
            if readable:
                chunk = os.read(process.stdout.fileno(), 65536)
                if not chunk:
                    output_open = False
                    continue
                if summary["first_output_seconds"] is None:
                    summary["first_output_seconds"] = round(time.monotonic() - started, 3)
                    record("first_output")
                sys.stdout.buffer.write(chunk)
                sys.stdout.buffer.flush()
                tail += chunk
                if (
                    summary["command_banner_seconds"] is None
                    and b"Command line invocation:" in tail
                ):
                    summary["command_banner_seconds"] = round(
                        time.monotonic() - started, 3
                    )
                    record("command_banner")
                    stop.set()
                tail = tail[-128:]
            elif process.poll() is not None:
                break
        if cancelled:
            terminate(process)
            result = 128 + cancelled[0]
        else:
            result = process.wait()
            if result < 0:
                result = 128 - result
        summary["exit_code"] = result
        record("compiler_finished", exit_code=result)
        return result
    finally:
        stop.set()
        if process is not None:
            if process.poll() is None:
                terminate(process)
            process.stdout.close()
        if observer is not None:
            observer.join()
        summary["cancelled"] = bool(cancelled)
        summary["total_seconds"] = round(time.monotonic() - started, 3)
        (args.output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
        for value, handler in original_handlers.items():
            signal.signal(value, handler)
        print("iOS sampled Xcode startup: " + json.dumps(summary), file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--delay", type=float, default=15)
    parser.add_argument("--window", type=float, default=240)
    parser.add_argument("--no-stack", action="store_true")
    parser.add_argument("output", type=Path)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.command[:1] == ["--"]:
        args.command = args.command[1:]
    if not args.command or Path(args.command[0]).name != "xcodebuild":
        parser.error("expected an xcodebuild command after OUTPUT --")
    if not 0 <= args.delay <= 60 or not 1 <= args.window <= 240:
        parser.error("delay must be 0–60 seconds and window must be 1–240 seconds")
    return observe(args)


if __name__ == "__main__":
    sys.exit(main())
