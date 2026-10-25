#!/usr/bin/env python3
"""Bounded manual scheduling experiment; CPU observations do not prove test readiness."""

import argparse
import os
import select
import signal
import subprocess
import time


def cancel(signum, _frame):
    raise SystemExit(128 + signum)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-seconds", type=float, default=90)
    args = parser.parse_args()
    started = time.monotonic()
    deadline = started + args.max_seconds
    samples = 0
    streak = 0
    last_idle = None
    status = "deadline"
    process = None
    for signum in [signal.SIGTERM, signal.SIGINT]:
        signal.signal(signum, cancel)
    try:
        if args.max_seconds <= 0:
            return
        process = subprocess.Popen(
            ["iostat", "-w", "1", "-c", "92"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env=os.environ | {"LC_ALL": "C"},
        )
        buffer = b""
        lifetime_row = True
        while time.monotonic() < deadline:
            readable, _, _ = select.select(
                [process.stdout], [], [], max(0, deadline - time.monotonic())
            )
            if not readable:
                break
            chunk = os.read(process.stdout.fileno(), 4096)
            if not chunk:
                status = "unavailable"
                break
            buffer += chunk
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                try:
                    values = [float(value) for value in line.split()]
                except ValueError:
                    continue
                if len(values) < 6:
                    continue
                if lifetime_row:
                    lifetime_row = False
                    continue
                last_idle = values[-4]
                if not 0 <= last_idle <= 100:
                    status = "unavailable"
                    return
                samples += 1
                streak = streak + 1 if last_idle >= 25 else 0
                print(f"iOS startup idle sample: {last_idle}%", flush=True)
                if streak >= 2:
                    status = "ready"
                    return
    except OSError as error:
        status = "unavailable"
        print(f"iOS startup idle observation unavailable: {error}", flush=True)
    finally:
        if process is not None:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            process.stdout.close()
        print(
            f"iOS startup headroom: {status}; elapsed={time.monotonic() - started:.3f}; "
            f"observations={samples}; last_idle={last_idle}",
            flush=True,
        )


if __name__ == "__main__":
    main()
