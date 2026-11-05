#!/usr/bin/env python3
"""Temporarily observe native dependency stores without caching build outputs."""

import hashlib
import json
import os
import platform
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


def command(*args):
    return subprocess.check_output(args, text=True, timeout=45).strip()


def storage(path):
    if not path.exists():
        return {"path": str(path), "exists": False}
    resolved = path.resolve()
    size = int(command("du", "-sk", str(resolved)).split()[0]) * 1024
    result = {"path": str(path), "resolved": str(resolved), "bytes": size}
    if path.is_dir():
        result["entries"] = sorted(p.name for p in path.iterdir())[:25]
    return result


def main():
    label = sys.argv[1]
    root = Path.cwd()
    toolchain_file = Path(os.environ["RUNNER_TEMP"]) / "desktop-dependency-tools.json"
    if label == "before":
        toolchain = {
            "os": platform.mac_ver()[0],
            "arch": platform.machine(),
            "xcode": command("xcodebuild", "-version"),
            "swift": command("xcrun", "swift", "--version"),
            "sdk": command("xcrun", "--sdk", "macosx", "--show-sdk-version"),
        }
        toolchain_file.write_text(json.dumps(toolchain, sort_keys=True))
    else:
        toolchain = json.loads(toolchain_file.read_text())
    stores = []
    for directory in (
        root / "desktop/.build",
        root / "desktop/ComputerUse/.build",
        root / "desktop/.build-app/SourcePackages",
    ):
        stores.extend(
            storage(directory / name)
            for name in (
                "repositories",
                "checkouts",
                "artifacts",
                "workspace-state.json",
            )
        )
    for directory in (
        Path.home() / "Library/Caches/org.swift.swiftpm",
        Path.home() / ".cache/org.swift.swiftpm",
        Path.home() / ".swiftpm/cache",
    ):
        stores.append(storage(directory))
        if directory.is_dir():
            stores.extend(
                storage(directory / name)
                for name in ("repositories", "artifacts", "manifests")
            )
    locks = {}
    for path in (
        root / "desktop/Package.resolved",
        root / "desktop/ComputerUse/Package.resolved",
        root
        / "desktop/Okou.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved",
    ):
        if path.is_file():
            locks[str(path.relative_to(root))] = {
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                "resolved": json.loads(path.read_text()),
            }
    result = {
        "label": label,
        "utc": datetime.now(timezone.utc).isoformat(),
        "source": command("git", "rev-parse", "HEAD"),
        "nativeTree": command("git", "rev-parse", "HEAD:desktop"),
        "toolchain": toolchain,
        "stores": stores,
        "locks": locks,
        "packages": {
            path.name: path.stat().st_size
            for path in (root / "desktop/out").glob("*.zip")
        },
    }
    print("DESKTOP_DEPENDENCY_OBSERVATION=" + json.dumps(result, sort_keys=True))
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
        summary.write(
            f"### Desktop dependency inventory: {label}\n\n```json\n"
            + json.dumps(result, indent=2, sort_keys=True)
            + "\n```\n"
        )


if __name__ == "__main__":
    main()
