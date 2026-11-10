"""Build pinned SwiftLint with native rules. Offline modes never build or fetch."""

import argparse
import fcntl
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RULES = Path(__file__).resolve().parent / "Rules"


def pin():
    values = dict(
        line.split("=", 1)
        for line in (ROOT / ".swiftlint-version").read_text().splitlines()
        if line and not line.startswith("#")
    )
    revision = values.get("revision", "")
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", values.get("version", "")):
        raise ValueError("Invalid SwiftLint version")
    if len(revision) != 40 or any(c not in "0123456789abcdef" for c in revision):
        raise ValueError("Invalid SwiftLint source revision")
    return values


def identity():
    digest = hashlib.sha256()
    inputs = [
        ROOT / ".swiftlint-version",
        Path(__file__).resolve(),
        *sorted(RULES.glob("*.swift")),
    ]
    for path in inputs:
        digest.update(path.relative_to(ROOT).as_posix().encode() + b"\0")
        digest.update(path.read_bytes() + b"\0")
    digest.update(f"{platform.system()}-{platform.machine()}".encode())
    return digest.hexdigest()


def checksum(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verify(binary):
    receipt = json.loads((binary.parent / "receipt.json").read_text())
    if receipt["identity"] != identity() or receipt["sha256"] != checksum(binary):
        raise ValueError(
            "SwiftLint binary does not match the current native rule sources"
        )
    version = subprocess.check_output([str(binary), "--version"], text=True).strip()
    if version != pin()["version"]:
        raise ValueError("SwiftLint version does not match ios/.swiftlint-version")
    return binary


def run(arguments, cwd=None):
    subprocess.run(arguments, cwd=cwd, stdout=sys.stderr, check=True)


def install(configuration):
    pinned = pin()
    cache = ROOT / ".tools" / "swiftlint"
    cache.mkdir(parents=True, exist_ok=True)
    expected = identity()
    destination = cache / expected
    binary = destination / "swiftlint"
    # Keep one stable lock inode for all callers of the reusable build tree.
    with (cache / "build.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if identity() != expected:
            raise ValueError(
                "Native rule sources changed while waiting for the build lock"
            )
        if binary.exists():
            return verify(binary)
        source = cache / "source" / pinned["revision"]
        if not (source / ".git").exists():
            source.mkdir(parents=True, exist_ok=True)
            run(["git", "init", "--quiet", str(source)])
        try:
            current = subprocess.check_output(
                ["git", "rev-parse", "HEAD"],
                cwd=source,
                stderr=subprocess.DEVNULL,
                text=True,
            ).strip()
        except subprocess.CalledProcessError:
            current = ""
        if current != pinned["revision"]:
            run(
                [
                    "git",
                    "fetch",
                    "--depth",
                    "1",
                    "https://github.com/realm/SwiftLint.git",
                    pinned["revision"],
                ],
                source,
            )
            run(["git", "checkout", "--detach", "FETCH_HEAD"], source)
        resolved = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=source, text=True
        ).strip()
        if resolved != pinned["revision"]:
            raise ValueError("Fetched SwiftLint source does not match its revision")
        # Restore our ignored build checkout before applying the rule overlay.
        run(["git", "restore", "--source", resolved, "--worktree", "."], source)
        run(["git", "clean", "-fd", "--", "Source"], source)
        extension = source / "Source" / "SwiftLintExtraRules"
        for path in extension.glob("*.swift"):
            if path.name != "Exports.swift":
                path.unlink()
        for path in RULES.glob("*.swift"):
            shutil.copy2(path, extension / path.name)
        jobs = int(os.environ.get("SWIFTLINT_BUILD_JOBS", "2"))
        if not 1 <= jobs <= 16:
            raise ValueError("SWIFTLINT_BUILD_JOBS must be between 1 and 16")
        run(
            [
                "swift",
                "build",
                "--build-system",
                "native",
                "--configuration",
                configuration,
                "--product",
                "swiftlint",
                "--jobs",
                str(jobs),
                "--force-resolved-versions",
                # Bound cold-build memory for the large SwiftSyntax module.
                "-Xswiftc",
                "-no-whole-module-optimization",
                "-Xswiftc",
                "-disable-batch-mode",
            ],
            source,
        )
        output = subprocess.check_output(
            [
                "swift",
                "build",
                "--build-system",
                "native",
                "--configuration",
                configuration,
                "--show-bin-path",
            ],
            cwd=source,
            text=True,
        ).strip()
        if identity() != expected:
            raise ValueError("Native rule sources changed during compilation")
        with tempfile.TemporaryDirectory(prefix=".publish-", dir=cache) as temporary:
            staging = Path(temporary) / "ready"
            staging.mkdir()
            shutil.copy2(Path(output) / "swiftlint", staging / "swiftlint")
            shutil.copy2(source / "LICENSE", staging / "LICENSE")
            receipt = {
                "identity": expected,
                "sha256": checksum(staging / "swiftlint"),
                "revision": resolved,
                "configuration": configuration,
                "toolchain": subprocess.check_output(
                    ["swift", "--version"], text=True
                ).strip(),
            }
            (staging / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
            verify(staging / "swiftlint")
            staging.rename(destination)
        return binary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--path-only", action="store_true")
    group.add_argument("--verify", type=Path)
    group.add_argument("--identity", action="store_true")
    parser.add_argument(
        "--configuration", choices=["debug", "release"], default="release"
    )
    args = parser.parse_args()
    pin()
    if args.identity:
        print(identity())
    elif args.verify:
        verify(args.verify.resolve())
    elif args.path_only:
        print(verify(ROOT / ".tools" / "swiftlint" / identity() / "swiftlint"))
    else:
        print(install(args.configuration))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(
            f"SwiftLint: {error}. Run bash ios/scripts/install-swiftlint.sh to build current rules.",
            file=sys.stderr,
        )
        sys.exit(1)
