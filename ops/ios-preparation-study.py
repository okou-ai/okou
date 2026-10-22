#!/usr/bin/env python3
"""One-shot hosted-Mac preparation experiment; never runs tests or publishes.

Run MODE with STUDY_DIR, RUNNER_TEMP and the normal iOS CI environment set.
MODE is parallel, resolve-first, boot-first or resolve-only. Uses the unchanged
production preparation and preboot scripts, recording command boundaries,
resource snapshots, and one three-second sample for commands exceeding 60s.
STUDY_LIGHTWEIGHT=true disables command shims and resource/stack sampling.
STUDY_COMPILE=true also measures the unchanged production compile command.
Artifacts belong to STUDY_DIR. Child failures propagate; owned process groups
are terminated on cancellation. No caches are saved by this experiment.
"""

import datetime
import json
import os
import shlex
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path


def event(kind, **fields):
    record = {
        "event": kind,
        "utc": datetime.datetime.now(datetime.UTC).isoformat(),
        "monotonic": time.monotonic(),
        **fields,
    }
    line = json.dumps(record) + "\n"
    fd = os.open(
        Path(os.environ["STUDY_DIR"]) / "events.jsonl",
        os.O_WRONLY | os.O_CREAT | os.O_APPEND,
        0o600,
    )
    try:
        os.write(fd, line.encode())
    finally:
        os.close(fd)
    print("STUDY " + line, end="", file=sys.stderr, flush=True)


def capture(command):
    try:
        result = subprocess.run(
            command,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=10,
        )
        return {"status": result.returncode, "output": result.stdout}
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"unavailable": str(error)}


def wrapped_command(tool, real, arguments):
    if tool == "xcodebuild":
        label = "xcodebuild-resolve"
    else:
        label = "xcrun-" + "-".join(arguments[:2])
    started = time.monotonic()
    process = subprocess.Popen(
        [real, *arguments],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    event("command-start", label=label, pid=process.pid)
    done = threading.Event()

    def sample_if_slow():
        if done.wait(60) or process.poll() is not None:
            return
        path = Path(os.environ["STUDY_DIR"]) / f"{label}-{process.pid}.sample.txt"
        result = capture(["/usr/bin/sample", str(process.pid), "3", "-file", str(path)])
        event("sample", label=label, pid=process.pid, result=result)

    sampler = threading.Thread(target=sample_if_slow)
    sampler.start()
    markers = (
        "Command line invocation:",
        "Resolve Package Graph",
        "Resolved source packages:",
        "Prebooting",
        "Monitoring boot status",
        "Device already booted",
        "Boot status",
        "Booted",
    )
    first = True
    try:
        for line in process.stdout:
            if first or any(marker in line for marker in markers):
                event(
                    "output",
                    label=label,
                    text=line.rstrip(),
                    elapsed=time.monotonic() - started,
                )
            first = False
            print(line, end="", flush=True)
        status = process.wait()
    finally:
        done.set()
        sampler.join(timeout=12)
    event(
        "command-end",
        label=label,
        pid=process.pid,
        status=status,
        elapsed=time.monotonic() - started,
    )
    return status


def main(mode):
    modes = {"parallel", "resolve-first", "boot-first", "resolve-only"}
    if mode not in modes:
        raise ValueError(f"Expected one of {sorted(modes)}")
    directory = Path(os.environ["STUDY_DIR"])
    directory.mkdir(parents=True, exist_ok=False)
    script = Path(__file__).resolve()
    lightweight = os.environ.get("STUDY_LIGHTWEIGHT") == "true"
    environment = dict(os.environ)
    if not lightweight:
        shim = directory / "bin"
        shim.mkdir()
        for tool in ("xcodebuild", "xcrun"):
            real = shutil.which(tool)
            if real is None:
                raise ValueError(f"Missing {tool}")
            path = shim / tool
            arguments = [sys.executable, str(script), "--command", tool, real]
            path.write_text("#!/bin/sh\nexec " + shlex.join(arguments) + ' "$@"\n')
            path.chmod(0o700)
        environment["PATH"] = str(shim) + os.pathsep + os.environ["PATH"]
    event(
        "metadata",
        mode=mode,
        sha=capture(["git", "rev-parse", "HEAD"]),
        ios_tree=capture(["git", "rev-parse", "HEAD:ios"]),
        hardware=capture(["sysctl", "hw.ncpu", "hw.memsize"]),
        os=capture(["sw_vers"]),
        image=os.environ.get("ImageVersion"),
        dependency_hit=os.environ.get("STUDY_DEPENDENCY_HIT"),
        lightweight=lightweight,
    )
    stop = threading.Event()

    def resources():
        with (directory / "resources.jsonl").open("w") as output:
            while not stop.is_set():
                record = {
                    "utc": datetime.datetime.now(datetime.UTC).isoformat(),
                    "monotonic": time.monotonic(),
                    "processes": capture(
                        ["ps", "-axo", "pid,ppid,%cpu,rss,comm", "-r"]
                    ),
                    "vm": capture(["vm_stat"]),
                    "swap": capture(["sysctl", "vm.swapusage"]),
                }
                output.write(json.dumps(record) + "\n")
                output.flush()
                stop.wait(15)

    monitor = threading.Thread(target=resources)
    if not lightweight:
        monitor.start()
    children = []
    phase_times = {}

    def start(label, command):
        started = time.monotonic()
        child = subprocess.Popen(command, env=environment, start_new_session=True)
        children.append(child)
        event("phase-start", label=label, pid=child.pid)

        def finished():
            status = child.wait()
            phase_times[label] = time.monotonic() - started
            event("phase-end", label=label, status=status, elapsed=phase_times[label])

        observer = threading.Thread(target=finished)
        observer.start()
        return label, child, observer

    def wait(phase):
        _label, child, observer = phase
        observer.join(timeout=900)
        if observer.is_alive():
            raise subprocess.TimeoutExpired(child.args, 900)
        status = child.returncode
        if status:
            raise subprocess.CalledProcessError(status, child.args)

    def prepare():
        return start("prepare", ["bash", "ios/scripts/ci-test.sh", "prepare"])

    def preboot():
        return start("preboot", [sys.executable, "ios/scripts/preboot-simulator.py"])

    def interrupted(signum, _frame):
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    started = time.monotonic()
    event("study-start", mode=mode)
    try:
        if mode == "parallel":
            boot = preboot()
            resolution = prepare()
            wait(resolution)
            wait(boot)
        elif mode == "resolve-first":
            wait(prepare())
            wait(preboot())
        elif mode == "boot-first":
            wait(preboot())
            wait(prepare())
        else:
            wait(prepare())
        prepared = time.monotonic() - started
        event("preparation-ready", elapsed=prepared)
        if os.environ.get("STUDY_COMPILE") == "true":
            wait(start("compile", ["bash", "ios/scripts/ci-test.sh", "compile"]))
        summary = {
            "mode": mode,
            "preparation_seconds": prepared,
            "total_seconds": time.monotonic() - started,
            "phases": phase_times,
        }
        (directory / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
        event("study-end", **summary)
    finally:
        for child in children:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
        stop.set()
        if not lightweight:
            monitor.join(timeout=35)


if __name__ == "__main__":
    if sys.argv[1] == "--command":
        sys.exit(wrapped_command(sys.argv[2], sys.argv[3], sys.argv[4:]))
    main(sys.argv[1])
