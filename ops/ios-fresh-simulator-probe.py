#!/usr/bin/env python3
"""Replace only this manual job's active simulator with a fresh identical model."""

import json
import os
import subprocess
import uuid
from pathlib import Path


def main():
    if os.environ.get("GITHUB_EVENT_NAME") != "workflow_dispatch":
        raise ValueError("Fresh simulator comparison requires a manual run")
    output = Path(os.environ["RUNNER_TEMP"]) / "okou-ios-ci/fresh-device.json"
    if output.exists():
        raise ValueError("Refusing to replace an existing fresh-device record")
    destination = dict(
        item.split("=", 1) for item in os.environ["IOS_TEST_DESTINATION"].split(",")
    )
    if (
        set(destination) != {"platform", "name", "OS"}
        or destination["platform"] != "iOS Simulator"
    ):
        raise ValueError("Expected an explicit model and runtime")
    runtime = "com.apple.CoreSimulator.SimRuntime.iOS-" + destination["OS"].replace(
        ".", "-"
    )
    inventory = json.loads(
        subprocess.check_output(
            ["xcrun", "simctl", "list", "devices", "available", "--json"], text=True
        )
    )
    matches = [
        d
        for d in inventory["devices"].get(runtime, [])
        if d["name"] == destination["name"]
    ]
    if len(matches) != 1 or matches[0]["state"] != "Booted":
        raise ValueError("Expected the one active simulator from the first full suite")
    original = matches[0]
    device_type = original["deviceTypeIdentifier"]
    name = "Okou Fresh Startup " + os.environ["GITHUB_RUN_ID"]
    created = subprocess.check_output(
        ["xcrun", "simctl", "create", name, device_type, runtime], text=True
    ).strip()
    created = str(uuid.UUID(created)).upper()
    record = {
        "source_udid": original["udid"],
        "udid": created,
        "name": name,
        "device_type": device_type,
        "runtime": runtime,
        "destination": "platform=iOS Simulator,id=" + created,
    }
    with output.open("x") as target:
        json.dump(record, target)
    print("iOS fresh simulator identity: " + json.dumps(record), flush=True)
    subprocess.run(["xcrun", "simctl", "shutdown", original["udid"]], check=True)
    subprocess.run(["xcrun", "simctl", "boot", created], check=True)
    subprocess.run(["xcrun", "simctl", "bootstatus", created], check=True)


if __name__ == "__main__":
    main()
