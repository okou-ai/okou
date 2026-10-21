#!/usr/bin/env python3
"""Fetch locked Git revisions into job-owned shallow sources for system Git.

Usage: prepare-package-sources.py Package.resolved BUILD_ROOT
Writes BUILD_ROOT/package-sources.gitconfig only after every fetch succeeds.
The caller includes that file in Git's runtime configuration for SwiftPM.
"""

import concurrent.futures
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


def prepare(resolved, build_root):
    pins = json.loads(resolved.read_text())["pins"]
    sources = Path(tempfile.mkdtemp(prefix="package-sources-", dir=build_root))

    def fetch(indexed_pin):
        index, pin = indexed_pin
        repo = sources / str(index)
        revision = pin["state"]["revision"]
        subprocess.run(["git", "init", "--quiet", "--bare", str(repo)], check=True)
        subprocess.run(
            [
                "git",
                "-C",
                str(repo),
                "fetch",
                "--quiet",
                "--depth=1",
                "--no-tags",
                "--",
                pin["location"],
                f"{revision}:refs/heads/pinned",
            ],
            check=True,
            timeout=120,
        )
        subprocess.run(
            ["git", "-C", str(repo), "symbolic-ref", "HEAD", "refs/heads/pinned"],
            check=True,
        )
        if version := pin["state"].get("version"):
            subprocess.run(
                [
                    "git",
                    "-C",
                    str(repo),
                    "update-ref",
                    f"refs/tags/{version}",
                    revision,
                ],
                check=True,
            )
        return pin["location"], repo.as_uri()

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        mirrors = list(pool.map(fetch, enumerate(pins)))
    config = sources / "gitconfig"
    config.touch()
    for original, mirror in mirrors:
        # SwiftPM normalizes an optional .git suffix before cloning.
        base = original.removesuffix(".git")
        for location in (base, base + ".git"):
            subprocess.run(
                [
                    "git",
                    "config",
                    "--file",
                    str(config),
                    "--add",
                    f"url.{mirror}.insteadOf",
                    location,
                ],
                check=True,
            )
    os.replace(config, build_root / "package-sources.gitconfig")


if __name__ == "__main__":
    prepare(Path(sys.argv[1]), Path(sys.argv[2]).resolve())
