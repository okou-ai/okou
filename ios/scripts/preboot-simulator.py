#!/usr/bin/env python3
"""Start the explicit CI simulator and await system boot readiness.

IOS_TEST_DESTINATION must specify platform=iOS Simulator, name and OS.
Callers own when startup occurs. Missing/ambiguous devices and boot or
readiness failures fail CI.
Selection failures print the original available-device inventory and allowlisted
CI context to stderr, then collect a separate full inventory with a 10s deadline.
"""

import json
import os
import subprocess
import sys
from datetime import datetime, timezone


def report_selection_failure(destination, runtime, devices, inventory):
    report = {
        "observedAt": datetime.now(timezone.utc).isoformat(),
        "destination": destination,
        "runtimeIdentifier": runtime,
        "matchCount": len(devices),
        "availableDeviceInventory": inventory,
        "environment": {
            key: os.environ[key]
            for key in (
                "DEVELOPER_DIR",
                "GITHUB_SHA",
                "GITHUB_RUN_ID",
                "GITHUB_RUN_ATTEMPT",
                "GITHUB_JOB",
                "RUNNER_NAME",
                "RUNNER_OS",
                "RUNNER_ARCH",
                "ImageOS",
                "ImageVersion",
            )
            if key in os.environ
        },
    }
    print(
        "Simulator selection failure:\n" + json.dumps(report, indent=2),
        file=sys.stderr,
        flush=True,
    )
    print(
        "Supplemental simctl inventory (later snapshot; not used for selection):",
        file=sys.stderr,
        flush=True,
    )
    try:
        result = subprocess.run(
            ["xcrun", "simctl", "list", "--json"],
            stdout=sys.stderr,
            timeout=10,
            check=False,
        )
        print(
            f"Supplemental simctl inventory exit status: {result.returncode}",
            file=sys.stderr,
            flush=True,
        )
    except subprocess.TimeoutExpired:
        print(
            "Supplemental simctl inventory timed out after 10s",
            file=sys.stderr,
            flush=True,
        )


def main():
    destination = dict(
        item.split("=", 1) for item in os.environ["IOS_TEST_DESTINATION"].split(",")
    )
    if (
        set(destination) != {"platform", "name", "OS"}
        or destination["platform"] != "iOS Simulator"
    ):
        raise ValueError("Expected an explicit CI simulator platform, name and OS")
    runtime = "com.apple.CoreSimulator.SimRuntime.iOS-" + destination["OS"].replace(
        ".", "-"
    )
    inventory = json.loads(
        subprocess.check_output(
            ["xcrun", "simctl", "list", "devices", "available", "--json"], text=True
        )
    )
    devices = [
        device
        for device in inventory["devices"].get(runtime, [])
        if device["name"] == destination["name"]
    ]
    if len(devices) != 1:
        report_selection_failure(
            os.environ["IOS_TEST_DESTINATION"], runtime, devices, inventory
        )
        raise ValueError(
            "Expected one available simulator matching the CI name and OS; "
            f"found {len(devices)} for {destination['name']} in {runtime}"
        )
    device = devices[0]
    print(
        f"Prebooting {device['name']} ({destination['OS']}): {device['udid']}",
        flush=True,
    )
    if device["state"] == "Shutdown":
        subprocess.run(["xcrun", "simctl", "boot", device["udid"]], check=True)
    elif device["state"] != "Booted":
        raise ValueError(f"Simulator cannot start from state {device['state']}")
    subprocess.run(["xcrun", "simctl", "bootstatus", device["udid"]], check=True)


if __name__ == "__main__":
    main()
