#!/usr/bin/env python3
"""Observe existing Cargo/linker commands without claiming rustc-internal timings."""

import json
import os
import resource
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path, PurePosixPath


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def optional_text(path):
    try:
        return path.read_text().strip()
    except (FileNotFoundError, PermissionError):
        return None


def cgroup_directory():
    membership = Path("/proc/self/cgroup").read_text()
    relative = (
        next(
            line.split("::", 1)[1]
            for line in membership.splitlines()
            if line.startswith("0::")
        )
        if "0::" in membership
        else None
    )
    if relative is None:
        return None
    membership_path = PurePosixPath(relative)
    for mount in Path("/proc/self/mountinfo").read_text().splitlines():
        fields, filesystem = mount.split(" - ", 1)
        if filesystem.split()[0] != "cgroup2":
            continue
        fields = fields.split()
        mount_root, mount_point = PurePosixPath(fields[3]), Path(fields[4])
        if membership_path.is_relative_to(mount_root):
            path = mount_point / str(membership_path.relative_to(mount_root))
        else:
            # A private cgroup namespace expresses membership relative to its root.
            path = mount_point / relative.lstrip("/")
        if (path / "cpu.stat").is_file():
            return path
    return None


def cgroup_cpu(path):
    value = None if path is None else optional_text(path / "cpu.stat")
    if value is None:
        return None
    return int(dict(line.split() for line in value.splitlines())["usage_usec"])


def measure(command, sample_container):
    group = cgroup_directory() if sample_container else None
    cpu_before = cgroup_cpu(group)
    samples = []
    stop = threading.Event()

    def sample():
        while True:
            raw = None if group is None else optional_text(group / "memory.current")
            if raw is not None:
                samples.append(int(raw))
            if stop.wait(0.1):
                return

    sampler = threading.Thread(target=sample)
    if sample_container:
        sampler.start()
    usage_before = resource.getrusage(resource.RUSAGE_CHILDREN)
    start = time.monotonic()
    try:
        result = subprocess.run(command, check=False)
        elapsed = time.monotonic() - start
    finally:
        stop.set()
        if sample_container:
            sampler.join()
    usage = resource.getrusage(resource.RUSAGE_CHILDREN)
    cpu_after = cgroup_cpu(group)
    return result.returncode, {
        "wallSeconds": elapsed,
        "childUserSeconds": usage.ru_utime - usage_before.ru_utime,
        "childSystemSeconds": usage.ru_stime - usage_before.ru_stime,
        "maxChildRssKiB": usage.ru_maxrss,
        "containerCpuSeconds": None
        if cpu_before is None or cpu_after is None
        else (cpu_after - cpu_before) / 1_000_000,
        "sampledContainerMemoryPeakBytes": max(samples) if samples else None,
        "containerMemorySampleIntervalSeconds": 0.1 if sample_container else None,
        "cgroupPath": str(group) if group is not None else None,
        "exitCode": result.returncode,
    }


def main():
    mode, *args = sys.argv[1:]
    trial = Path(os.environ["RUNNER_BENCHMARK_TRIAL_DIR"])
    if mode == "linker":
        status, metrics = measure(
            [os.environ["RUNNER_BENCHMARK_REAL_LINKER"], *args], False
        )
        output = args[args.index("-o") + 1] if "-o" in args else None
        metrics.update(
            {
                "phase": os.environ["RUNNER_BENCHMARK_PHASE"],
                "outputFile": Path(output).name if output is not None else None,
            }
        )
        write_json(trial / f"linker-{os.getpid()}.json", metrics)
        return status
    if mode != "cargo":
        raise ValueError("unknown instrumentation mode")
    if not args or args[0] != "build":
        raise ValueError("only canonical cargo build commands are instrumented")
    packages = [args[i + 1] for i, arg in enumerate(args) if arg == "-p"]
    phase = "runner" if packages == ["runner"] else "guest"
    os.environ["RUNNER_BENCHMARK_PHASE"] = phase
    subprocess.run(["sccache", "--zero-stats"], check=True, stdout=subprocess.DEVNULL)
    status, metrics = measure(
        [os.environ["RUNNER_BENCHMARK_REAL_CARGO"], *args, "--timings"], True
    )
    metrics["packages"] = packages
    write_json(trial / f"{phase}.json", metrics)
    stats = subprocess.run(
        ["sccache", "--show-stats", "--stats-format", "json"],
        capture_output=True,
        text=True,
        check=False,
    )
    if status != 0:
        # Diagnostic collection must not replace a compiler/linker failure status.
        (trial / f"{phase}-sccache.txt").write_text(stats.stdout + stats.stderr)
        return status
    stats.check_returncode()
    write_json(trial / f"{phase}-sccache.json", json.loads(stats.stdout))
    timing = Path(os.environ["CARGO_TARGET_DIR"]) / "cargo-timings/cargo-timing.html"
    shutil.copyfile(timing, trial / f"{phase}-cargo-timing.html")
    return 0


if __name__ == "__main__":
    sys.exit(main())
