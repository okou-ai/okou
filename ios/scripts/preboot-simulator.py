#!/usr/bin/env python3
"""Start the explicit CI simulator and await system boot readiness.

IOS_TEST_DESTINATION must specify platform=iOS Simulator, name and OS.
Callers own when startup occurs. Missing/ambiguous devices and boot or
readiness failures fail CI.
"""

import json
import os
import subprocess
import time
from datetime import datetime, timezone


def simctl(phase, *arguments, capture=False):
    started = time.monotonic()
    print(
        "iOS simulator event: "
        + json.dumps(
            {
                "phase": phase,
                "event": "started",
                "utc": datetime.now(timezone.utc).isoformat(),
            }
        ),
        flush=True,
    )
    result = subprocess.run(
        ["xcrun", "simctl", *arguments],
        text=True,
        stdout=subprocess.PIPE if capture else None,
        check=False,
    )
    print(
        "iOS simulator event: "
        + json.dumps(
            {
                "phase": phase,
                "event": "finished",
                "utc": datetime.now(timezone.utc).isoformat(),
                "seconds": round(time.monotonic() - started, 3),
                "exit_code": result.returncode,
            }
        ),
        flush=True,
    )
    result.check_returncode()
    return result.stdout


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
        simctl("inventory", "list", "devices", "available", "--json", capture=True)
    )
    devices = [
        device
        for device in inventory["devices"].get(runtime, [])
        if device["name"] == destination["name"]
    ]
    if len(devices) != 1:
        raise ValueError("Expected one available simulator matching the CI name and OS")
    device = devices[0]
    print(
        f"Prebooting {device['name']} ({destination['OS']}): {device['udid']}; initial state: {device['state']}",
        flush=True,
    )
    if device["state"] == "Shutdown":
        simctl("boot", "boot", device["udid"])
    elif device["state"] != "Booted":
        raise ValueError(f"Simulator cannot start from state {device['state']}")
    simctl("bootstatus", "bootstatus", device["udid"])


if __name__ == "__main__":
    main()
