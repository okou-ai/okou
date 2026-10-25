#!/usr/bin/env python3
"""Start the explicit CI simulator and await system boot readiness.

IOS_TEST_DESTINATION must specify platform=iOS Simulator, name and OS.
Callers own when startup occurs. Missing/ambiguous devices and boot or
readiness failures fail CI.
"""

import argparse
import json
import os
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--select-only", action="store_true")
    args = parser.parse_args()
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
        raise ValueError("Expected one available simulator matching the CI name and OS")
    device = devices[0]
    if device["state"] not in {"Shutdown", "Booted"}:
        raise ValueError(f"Simulator cannot start from state {device['state']}")
    if args.select_only:
        print(device["udid"], flush=True)
        return
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
