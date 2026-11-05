#!/usr/bin/env python3
"""One-run cold/warm simulator comparison; process snapshots omit argv and env."""

import datetime
import json
import os
from pathlib import Path
import subprocess
import sys
import time

output = Path(sys.argv[1])
output.mkdir(mode=0o700)
started = time.monotonic()
measurements = []


def execute(label, command, timeout=20, required=False):
    begin = time.monotonic()
    record = {
        "label": label,
        "utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "elapsed_seconds": round(begin - started, 3),
    }
    try:
        result = subprocess.run(
            command, capture_output=True, text=True, timeout=timeout, check=False
        )
        record["exit_code"] = result.returncode
        text = result.stdout + result.stderr
        (output / f"{label}.txt").write_text(text[: 256 * 1024])
        record["truncated"] = len(text) > 256 * 1024
        if required and result.returncode:
            raise RuntimeError(f"Required probe failed: {label}")
        return result.stdout
    except (OSError, subprocess.TimeoutExpired) as error:
        record["error"] = str(error)
        if required:
            raise
        return ""
    finally:
        record["seconds"] = round(time.monotonic() - begin, 3)
        measurements.append(record)
        (output / "measurements.json").write_text(json.dumps(measurements, indent=2))
        print("iOS startup comparison: " + json.dumps(record), flush=True)


def snapshot(label):
    execute(label + "-cpu", ["iostat", "-w", "1", "-c", "2"], timeout=10)
    execute(label + "-memory", ["vm_stat"])
    execute(
        label + "-processes",
        ["ps", "-axo", "pid=,ppid=,pcpu=,pmem=,rss=,state=,time=,comm="],
    )


execute("hardware", ["sysctl", "hw.ncpu", "hw.memsize", "vm.swapusage"])
snapshot("before-cold-boot")
inventory = json.loads(
    execute(
        "devices",
        ["xcrun", "simctl", "list", "devices", "available", "--json"],
        required=True,
    )
)
destination = dict(
    item.split("=", 1) for item in os.environ["IOS_TEST_DESTINATION"].split(",")
)
runtime = "com.apple.CoreSimulator.SimRuntime.iOS-" + destination["OS"].replace(
    ".", "-"
)
devices = [
    d for d in inventory["devices"].get(runtime, []) if d["name"] == destination["name"]
]
if len(devices) != 1 or devices[0]["state"] != "Shutdown":
    raise ValueError(
        "Cold/warm comparison requires the exact configured shutdown simulator"
    )
device = devices[0]["udid"]
boot = [sys.executable, "ios/scripts/preboot-simulator.py"]
execute("cold-boot", boot, timeout=600, required=True)
snapshot("after-cold-boot")
execute("cold-xcode-version", ["xcodebuild", "-version"], timeout=420, required=True)
snapshot("after-cold-version")
execute("shutdown", ["xcrun", "simctl", "shutdown", device], timeout=120, required=True)
execute("warm-boot", boot, timeout=600, required=True)
snapshot("after-warm-boot")
execute("warm-xcode-version", ["xcodebuild", "-version"], timeout=420, required=True)
snapshot("after-warm-version")
