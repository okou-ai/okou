#!/usr/bin/env python3
"""Measure same-source Release archives; only same-run native caches are restored.

Run prepare/restore/report/seed from the repository root in the diagnostic workflow.
Requires RUNNER_TEMP, GITHUB_ENV, IOS_ARCHIVE_CACHE_MODE and IOS_ARCHIVE_CACHE_LABEL.
"""

import argparse
import json
import os
import plistlib
import re
import shutil
import subprocess
import tarfile
import time
from pathlib import Path


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["prepare", "restore", "report", "seed"])
    operation = parser.parse_args().operation
    mode = os.environ["IOS_ARCHIVE_CACHE_MODE"]
    label = os.environ["IOS_ARCHIVE_CACHE_LABEL"]
    if mode not in {"baseline", "seed", "warm"} or not re.fullmatch(r"[a-z-]+", label):
        raise ValueError("Invalid diagnostic archive condition")
    temporary = Path(os.environ["RUNNER_TEMP"])
    work = temporary / "okou-ios-promotion"
    output = temporary / "ios-archive-cache-measurement"
    seed = temporary / "ios-archive-cache-seed"
    identity = output / "identity.json"
    cache_paths = ["SourcePackages", "DerivedData/CompilationCache.noindex"]

    if operation == "prepare":
        output.mkdir()
        write_json(output / "started.json", time.monotonic())
        work.mkdir()
        for command in [
            ["toolchain", str(output / "toolchain.json")],
            [
                "inputs",
                "--toolchain",
                str(output / "toolchain.json"),
                "--output",
                str(output / "inputs.json"),
            ],
        ]:
            subprocess.run(
                ["python3", "ios/scripts/archive-promotion.py", *command], check=True
            )
        write_json(
            identity,
            {
                "commit": subprocess.check_output(
                    ["git", "rev-parse", "HEAD"], text=True
                ).strip(),
                "inputs": json.loads((output / "inputs.json").read_text()),
                "configuration": "Release",
                "destination": "generic/platform=iOS",
                "nativeCacheEnabled": mode != "baseline",
            },
        )
        write_json(
            output / "host.json",
            {
                "image": os.environ.get("ImageVersion"),
                "imageOS": os.environ.get("ImageOS"),
                "macOSBuild": subprocess.check_output(
                    ["sw_vers", "-buildVersion"], text=True
                ).strip(),
                "cpuCount": os.cpu_count(),
                "memoryBytes": subprocess.check_output(
                    ["sysctl", "-n", "hw.memsize"], text=True
                ).strip(),
            },
        )
        with Path(os.environ["GITHUB_ENV"]).open("a") as environment:
            environment.write(
                f"IOS_ARCHIVE_DIR={work}\nIOS_ARCHIVE_MEASUREMENT_DIR={output}\n"
            )
    elif operation == "restore":
        if (
            mode != "warm"
            or identity.read_bytes() != (seed / "identity.json").read_bytes()
        ):
            raise ValueError("Release cache inputs do not match this archive")
        with tarfile.open(seed / "cache.tar") as archive:
            for member in archive.getmembers():
                if not any(
                    member.name == path or member.name.startswith(path + "/")
                    for path in cache_paths
                ):
                    raise ValueError(f"Unexpected cache entry: {member.name}")
            archive.extractall(work, filter="data")
    elif operation == "seed":
        if mode != "seed" or not all((work / path).is_dir() for path in cache_paths):
            raise ValueError(
                "Expected dependency and native compiler caches from a successful seed"
            )
        seed.mkdir()
        shutil.copy2(identity, seed / "identity.json")
        with tarfile.open(seed / "cache.tar", "w") as archive:
            for path in cache_paths:
                archive.add(work / path, arcname=path)
        print(f"Release cache payload: {(seed / 'cache.tar').stat().st_size} bytes")
    else:
        elapsed = time.monotonic() - json.loads((output / "started.json").read_text())
        log = (output / "build.log").read_text(errors="replace")
        phases = dict(re.findall(r"iOS archive ([a-z ]+): (\d+) seconds", log))
        if set(phases) != {
            "dependency preparation",
            "compilation",
            "validation and packaging",
        }:
            raise ValueError("Missing completed archive measurements")
        with (
            work / "Original.xcarchive/Products/Applications/Okou.app/Info.plist"
        ).open("rb") as file:
            info = plistlib.load(file)
        summary = {
            "label": label,
            "mode": mode,
            "elapsedSecondsIncludingCacheRestore": round(elapsed, 3),
            "phaseSeconds": {name: int(value) for name, value in phases.items()},
            "archiveSHA256": (work / "archive-sha256.txt").read_text().strip(),
            "application": {
                key: info[key]
                for key in [
                    "CFBundleIdentifier",
                    "CFBundleShortVersionString",
                    "CFBundleVersion",
                    "CFBundleSupportedPlatforms",
                ]
            },
            "cacheStatistics": [
                line for line in log.splitlines() if "cache hit rate" in line
            ][-20:],
        }
        write_json(output / "summary.json", summary)
        print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
