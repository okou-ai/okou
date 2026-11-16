#!/usr/bin/env python3
"""Run Gradle with a deadline, streaming managed-emulator logcat before teardown.

Usage: run-native-tests.py OUTPUT_DIRECTORY -- COMMAND [ARG...]
Requires ANDROID_HOME and an isolated emulator host. Only emulator-* devices are
observed. Gradle owns device provisioning/teardown; this wrapper owns its command
process group and read-only logcat children. Exit 124 means the 15-minute command
deadline expired; other failures/signals retain their exit status.
"""

import argparse
import os
from pathlib import Path
import signal
import subprocess
import time


def stop(process):
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        # Exiting before termination is normal; wait below still reaps the child.
        pass
    try:
        process.wait(timeout=30)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            # The child may exit between the wait deadline and this signal.
            pass
        process.wait()


def run(output, command, timeout=900):
    output.mkdir(parents=True, exist_ok=True)
    adb = str(Path(os.environ["ANDROID_HOME"]) / "platform-tools/adb")
    cancelled = 0

    def cancel(signum, _frame):
        nonlocal cancelled
        cancelled = 128 + signum

    previous = {sig: signal.signal(sig, cancel) for sig in (signal.SIGINT, signal.SIGTERM)}
    readers = {}
    child = None
    deadline = time.monotonic() + timeout
    try:
        with (output / "adb.log").open("wb") as diagnostics:
            child = subprocess.Popen(command, start_new_session=True)
            while child.poll() is None and not cancelled:
                if time.monotonic() >= deadline:
                    print(f"Native test command exceeded its {timeout}-second deadline", flush=True)
                    return 124
                devices = subprocess.run(
                    [adb, "devices"], stdout=subprocess.PIPE, stderr=diagnostics,
                    timeout=10, check=True, text=True,
                )
                for line in devices.stdout.splitlines():
                    parts = line.split()
                    if len(parts) == 2 and parts[0].startswith("emulator-") and parts[1] == "device":
                        serial = parts[0]
                        if serial not in readers or readers[serial][0].poll() is not None:
                            if serial in readers:
                                stop(readers[serial][0])
                                readers[serial][1].close()
                            # Managed provisioning can reboot/reconnect a device.
                            # Keep earlier evidence when its logcat stream ends.
                            stream = (output / f"{serial}.log").open("ab")
                            try:
                                reader = subprocess.Popen(
                                    [adb, "-s", serial, "logcat", "-b", "all", "-v", "threadtime"],
                                    stdout=stream, stderr=diagnostics, start_new_session=True,
                                )
                            except BaseException:
                                stream.close()
                                raise
                            readers[serial] = (reader, stream)
                # Polling device availability is independent of test synchronization.
                try:
                    child.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    # The command is still running; continue device/logcat discovery.
                    pass
            return cancelled or (child.returncode if child.returncode >= 0 else 128 - child.returncode)
    finally:
        if child is not None:
            stop(child)
        for reader, stream in readers.values():
            stop(reader)
            stream.close()
        for sig, handler in previous.items():
            signal.signal(sig, handler)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout-seconds", type=int, default=900)
    parser.add_argument("output", type=Path)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if not args.command:
        parser.error("a command after -- is required")
    raise SystemExit(run(args.output, args.command, args.timeout_seconds))
