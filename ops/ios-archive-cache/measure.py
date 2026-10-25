#!/usr/bin/env python3
"""Measure Release archives using the production persistent cache path.

Run prepare/report from the repository root in the diagnostic workflow.
Requires RUNNER_TEMP, GITHUB_ENV, IOS_ARCHIVE_CACHE_MODE and IOS_ARCHIVE_CACHE_LABEL.
"""

import argparse
import json
import os
import plistlib
import re
import subprocess
import time
from pathlib import Path


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["prepare", "report"])
    operation = parser.parse_args().operation
    mode = os.environ["IOS_ARCHIVE_CACHE_MODE"]
    label = os.environ["IOS_ARCHIVE_CACHE_LABEL"]
    if mode not in {"baseline", "seed", "warm"} or not re.fullmatch(r"[a-z-]+", label):
        raise ValueError("Invalid diagnostic archive condition")
    temporary = Path(os.environ["RUNNER_TEMP"])
    work = temporary / "okou-ios-promotion"
    output = temporary / "ios-archive-cache-measurement"
    identity = output / "identity.json"

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
            "elapsedSecondsIncludingCacheIO": round(elapsed, 3),
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
            "dependenciesExactHit": os.environ["IOS_CACHE_DEPENDENCIES_HIT"] == "true",
            "compilationExactHit": os.environ["IOS_CACHE_COMPILATION_HIT"] == "true",
            "replayHits": len(
                re.findall(r"^note: replay cache hit\b", log, re.MULTILINE)
            ),
            "replayMisses": len(
                re.findall(r"^note: replay cache miss\b", log, re.MULTILINE)
            ),
        }
        write_json(output / "summary.json", summary)
        print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
