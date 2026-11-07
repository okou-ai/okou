#!/usr/bin/env python3
"""Start the explicit CI simulator and await system boot readiness.

IOS_TEST_DESTINATION must specify platform=iOS Simulator, name and OS.
IOS_SIMULATOR_PROFILE defaults to standard. The opt-in lean CI experiment
disables only wallpaper/widget services before boot and verifies the result.
The caller must invoke `restore` after retiring its test/preboot processes.
"""

import json
import os
import plistlib
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from uuid import UUID

LEAN_SERVICES = ("com.apple.PosterBoard", "com.apple.chronod")


def simctl(phase, *args, capture=False, check=True):
    started = time.monotonic()
    try:
        return subprocess.run(
            ["xcrun", "simctl", *args],
            check=check,
            capture_output=capture,
            text=True,
        )
    except subprocess.CalledProcessError as error:
        if capture and error.stderr:
            print(error.stderr, file=sys.stderr, end="", flush=True)
        raise
    finally:
        print(
            f"iOS simulator {phase}: {time.monotonic() - started:.3f} seconds",
            flush=True,
        )


def profile_state():
    return Path(os.environ["RUNNER_TEMP"]) / "okou-ios-ci/simulator-profile.json"


def launchd_directory(udid):
    # /var/tmp resolves to /private/var/tmp on macOS. Never accept a path from state.
    return (
        Path("/var/tmp")
        / f"com.apple.CoreSimulator.SimDevice.{str(UUID(udid)).upper()}"
    )


def atomic_write(path, content, mode=0o600):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as output:
        temporary = Path(output.name)
        try:
            output.write(content)
            output.flush()
            os.fchmod(output.fileno(), mode)
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def apply_lean_profile(runtime, device):
    if (
        os.environ.get("GITHUB_ACTIONS") != "true"
        or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted"
        or runtime != "com.apple.CoreSimulator.SimRuntime.iOS-27-0"
    ):
        raise ValueError(
            "The lean experiment requires an ephemeral iOS 27.0 CI simulator"
        )
    if device["state"] != "Shutdown":
        raise ValueError("The lean profile must be applied before simulator boot")
    inventory = json.loads(
        simctl("runtime inventory", "list", "runtimes", "--json", capture=True).stdout
    )
    (selected,) = [
        item for item in inventory["runtimes"] if item["identifier"] == runtime
    ]
    root = Path(selected["bundlePath"]) / "Contents/Resources/RuntimeRoot"
    # Wallpaper is a LaunchAngel, not a LaunchDaemon or a registered user app.
    definitions = {
        "com.apple.PosterBoard": root
        / "System/Library/LaunchAngels/com.apple.PosterBoard.plist",
        "com.apple.chronod": root
        / "System/Library/LaunchDaemons/com.apple.chronod.plist",
    }
    for label, path in definitions.items():
        with path.open("rb") as source:
            if plistlib.load(source)["Label"] != label:
                raise ValueError(f"Unexpected simulator service identity in {path}")
    print(
        "iOS simulator service definitions: "
        + json.dumps({label: str(path) for label, path in definitions.items()}),
        flush=True,
    )

    directory = launchd_directory(device["udid"])
    created_directory = not directory.exists()
    if directory.is_symlink() or (
        directory.exists() and directory.stat().st_uid != os.getuid()
    ):
        raise ValueError("Simulator launchd directory is not owned by this CI user")
    path = directory / "disabled.plist"
    if path.is_symlink():
        raise ValueError("Simulator launchd database must not be a symlink")
    existed = path.exists()
    disabled = plistlib.loads(path.read_bytes()) if existed else {}
    mode = path.stat().st_mode & 0o777 if existed else 0o600
    state = profile_state()
    if state.exists():
        raise ValueError(
            "Restore the previous simulator profile before applying another"
        )
    print(
        "iOS simulator original profile flags: "
        + json.dumps({label: disabled.get(label) for label in LEAN_SERVICES}),
        flush=True,
    )
    state.parent.mkdir(parents=True, exist_ok=True)
    atomic_write(
        state,
        json.dumps(
            {
                "udid": device["udid"],
                "existed": existed,
                "mode": mode,
                "created_directory": created_directory,
                "values": {label: disabled.get(label) for label in LEAN_SERVICES},
            }
        ).encode(),
    )
    directory.mkdir(mode=0o700, exist_ok=True)
    disabled.update(dict.fromkeys(LEAN_SERVICES, True))
    atomic_write(path, plistlib.dumps(disabled, fmt=plistlib.FMT_BINARY), mode)
    print("iOS simulator lean profile applied: " + ", ".join(LEAN_SERVICES), flush=True)


def verify_lean_profile(udid):
    disabled = simctl(
        "profile verification",
        "spawn",
        udid,
        "launchctl",
        "print-disabled",
        "system",
        capture=True,
    ).stdout
    for label in LEAN_SERVICES:
        if f'"{label}" => true' not in disabled:
            raise ValueError(f"Simulator did not disable {label}")
        result = simctl(
            "service verification",
            "spawn",
            udid,
            "launchctl",
            "print",
            f"system/{label}",
            capture=True,
            check=False,
        )
        if (
            result.returncode != 113
            or f'Could not find service "{label}"' not in result.stderr
        ):
            # Retain service state without exposing launchctl's arguments/environment.
            fields = [
                line.strip()[:300]
                for line in result.stdout.splitlines()
                if line.strip().split(" = ", 1)[0]
                in {"state", "pid", "active count", "runs"}
            ][:8]
            raise ValueError(
                f"Simulator service is still loaded or could not be verified: {label}: "
                f"status={result.returncode}, fields={fields}, error={result.stderr}"
            )
    print("iOS simulator lean profile verified", flush=True)


def restore_profile():
    state = profile_state()
    if not state.exists():
        return
    original = json.loads(state.read_text())
    directory = launchd_directory(original["udid"])
    path = directory / "disabled.plist"
    if directory.is_symlink() or path.is_symlink():
        raise ValueError("Simulator profile paths must not be symlinks")
    disabled = plistlib.loads(path.read_bytes()) if path.exists() else {}
    for label, value in original["values"].items():
        if value is None:
            disabled.pop(label, None)
        else:
            disabled[label] = value
    if original["existed"] or disabled:
        atomic_write(
            path, plistlib.dumps(disabled, fmt=plistlib.FMT_BINARY), original["mode"]
        )
    else:
        path.unlink(missing_ok=True)
    if (
        original["created_directory"]
        and directory.exists()
        and not any(directory.iterdir())
    ):
        directory.rmdir()
    state.unlink()
    print("iOS simulator lean profile restored", flush=True)


def main():
    if sys.argv[1:] == ["restore"]:
        restore_profile()
        return
    if sys.argv[1:]:
        raise ValueError("usage: preboot-simulator.py [restore]")
    profile = os.environ.get("IOS_SIMULATOR_PROFILE", "standard")
    if profile not in ("standard", "lean"):
        raise ValueError(f"Unknown simulator profile: {profile}")
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
        simctl(
            "device inventory", "list", "devices", "available", "--json", capture=True
        ).stdout
    )
    devices = [
        device
        for device in inventory["devices"].get(runtime, [])
        if device["name"] == destination["name"]
    ]
    if len(devices) != 1:
        raise ValueError("Expected one available simulator matching the CI name and OS")
    device = devices[0]
    print(f"iOS simulator profile: {profile}", flush=True)
    if profile == "lean":
        apply_lean_profile(runtime, device)
    print(
        f"Prebooting {device['name']} ({destination['OS']}): {device['udid']}",
        flush=True,
    )
    if device["state"] == "Shutdown":
        simctl("boot request", "boot", device["udid"])
    elif device["state"] != "Booted":
        raise ValueError(f"Simulator cannot start from state {device['state']}")
    simctl("boot readiness", "bootstatus", device["udid"])
    if profile == "lean":
        verify_lean_profile(device["udid"])


if __name__ == "__main__":
    main()
