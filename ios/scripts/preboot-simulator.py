#!/usr/bin/env python3
"""Start the explicit CI simulator while locked dependencies resolve.

IOS_TEST_DESTINATION must specify platform=iOS Simulator, name and OS.
Wait for system boot readiness before compilation, rather than deferring
first-boot preparation to test launch. Missing/ambiguous devices and boot or
readiness failures fail CI.
"""

import json
import os
import subprocess
import time


def main():
    started = time.monotonic()
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
    discovery_started = time.monotonic()
    inventory = json.loads(
        subprocess.check_output(
            ["xcrun", "simctl", "list", "devices", "available", "--json"], text=True
        )
    )
    print(
        f"iOS simulator discovery: {time.monotonic() - discovery_started:.3f} seconds",
        flush=True,
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
        f"Prebooting {device['name']} ({destination['OS']}): {device['udid']} "
        f"(initial state: {device['state']})",
        flush=True,
    )
    boot_started = time.monotonic()
    if device["state"] == "Shutdown":
        subprocess.run(["xcrun", "simctl", "boot", device["udid"]], check=True)
    elif device["state"] != "Booted":
        raise ValueError(f"Simulator cannot start from state {device['state']}")
    print(
        f"iOS simulator boot: {time.monotonic() - boot_started:.3f} seconds",
        flush=True,
    )
    readiness_started = time.monotonic()
    subprocess.run(["xcrun", "simctl", "bootstatus", device["udid"]], check=True)
    print(
        f"iOS simulator readiness: {time.monotonic() - readiness_started:.3f} seconds",
        flush=True,
    )
    print(f"iOS simulator total: {time.monotonic() - started:.3f} seconds", flush=True)


if __name__ == "__main__":
    main()
