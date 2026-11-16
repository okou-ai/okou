#!/usr/bin/env python3
"""Dispatch-only two-Mac experiment; all native test selection stays in ci-test.sh.

Requires the normal iOS CI environment and captured IOS_ARCHIVE_DIR inputs.
Producer and consumer are bound to this repository, commit, run and attempt.
GH_TOKEN is read only by gh, never copied into manifests or command arguments.
"""

import hashlib
import json
import os
import platform
import re
import signal
import subprocess
import sys
import tarfile
import time
from datetime import UTC, datetime
from pathlib import Path


def stamp(event, **fields):
    print(
        "IOS_TWO_MAC="
        + json.dumps({"event": event, "utc": datetime.now(UTC).isoformat(), **fields}),
        flush=True,
    )


def context():
    return {
        key: os.environ[key]
        for key in (
            "GITHUB_REPOSITORY",
            "GITHUB_SHA",
            "GITHUB_RUN_ID",
            "GITHUB_RUN_ATTEMPT",
        )
    }


def checksum(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def read_inputs():
    return json.loads((Path(os.environ["IOS_ARCHIVE_DIR"]) / "inputs.json").read_text())


def check_host():
    data = json.loads((Path.home() / "imagedata.json").read_text())
    detail = next(item["detail"] for item in data if item["group"] == "Runner Image")
    image = re.search(r"(?m)^Version: (\S+)$", detail).group(1)
    version = subprocess.check_output(["sw_vers", "-productVersion"], text=True).strip()
    build = subprocess.check_output(["sw_vers", "-buildVersion"], text=True).strip()
    stamp(
        "host", image=image, macos=version, build=build, architecture=platform.machine()
    )
    if (image, version, platform.machine()) != ("20261112.0361.1", "27.2", "arm64"):
        raise ValueError("Experiment host image mismatch; exclude this sample")


def pack():
    started = time.monotonic()
    root = Path(os.environ["RUNNER_TEMP"])
    work = root / "okou-ios-ci"
    products = work / "DerivedData/Build/Products"
    specs = list(products.glob("*.xctestrun"))
    if len(specs) != 1:
        raise ValueError("Expected one completed native test specification")
    output = root / "ios-test-products"
    output.mkdir()
    bundle = output / "products.tar.gz"
    with tarfile.open(bundle, "w:gz", compresslevel=1) as archive:
        archive.add(products, arcname="Products")
    lock = (work / "Package.resolved.before").read_bytes()
    (output / "Package.resolved.before").write_bytes(lock)
    manifest = {
        "context": context(),
        "inputs": read_inputs(),
        "bundleSha256": checksum(bundle),
        "lockSha256": hashlib.sha256(lock).hexdigest(),
        "specification": specs[0].name,
        "bytes": bundle.stat().st_size,
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    stamp("packed", seconds=round(time.monotonic() - started, 3), **manifest)


def fetch():
    started = time.monotonic()
    repo = os.environ["GITHUB_REPOSITORY"]
    run = os.environ["GITHUB_RUN_ID"]
    attempt = os.environ["GITHUB_RUN_ATTEMPT"]
    output = Path(os.environ["RUNNER_TEMP"]) / "ios-test-transfer"
    output.mkdir()
    # The 30-minute consumer job is the overall deadline; each read is also bounded.
    while True:
        jobs = json.loads(
            subprocess.check_output(
                [
                    "gh",
                    "api",
                    f"repos/{repo}/actions/runs/{run}/attempts/{attempt}/jobs?per_page=100",
                ],
                text=True,
                timeout=30,
            )
        )["jobs"]
        producers = [job for job in jobs if job["name"] == "build-test-products"]
        if len(producers) > 1:
            raise ValueError("Ambiguous test-products producer")
        if producers and producers[0]["status"] == "completed":
            if producers[0]["conclusion"] != "success":
                raise ValueError("Native test-products producer did not succeed")
            break
        time.sleep(5)
    stamp("producer_succeeded", seconds=round(time.monotonic() - started, 3))
    subprocess.run(
        [
            "gh",
            "run",
            "download",
            run,
            "--repo",
            repo,
            "--name",
            f"ios-test-products-{run}-{attempt}",
            "--dir",
            str(output),
        ],
        check=True,
        timeout=180,
    )
    stamp("downloaded", seconds=round(time.monotonic() - started, 3))


def unpack(source, work, expected_context, expected_inputs, lock):
    manifest = json.loads((source / "manifest.json").read_text())
    if manifest["context"] != expected_context or manifest["inputs"] != expected_inputs:
        raise ValueError("Native test-products source/run/toolchain mismatch")
    bundle = source / "products.tar.gz"
    saved_lock = (source / "Package.resolved.before").read_bytes()
    if checksum(bundle) != manifest["bundleSha256"]:
        raise ValueError("Native test-products checksum mismatch")
    if (
        hashlib.sha256(saved_lock).hexdigest() != manifest["lockSha256"]
        or saved_lock != lock
    ):
        raise ValueError("Compiled package lock mismatch")
    destination = work / "DerivedData/Build"
    destination.mkdir(parents=True)
    with tarfile.open(bundle) as archive:
        for member in archive.getmembers():
            if Path(member.name).parts[0] != "Products":
                raise ValueError("Unexpected native products archive root")
        archive.extractall(destination, filter="data")
    specs = list((destination / "Products").glob("*.xctestrun"))
    if len(specs) != 1 or specs[0].name != manifest["specification"]:
        raise ValueError("Transferred native test specification mismatch")
    (work / "Package.resolved.before").write_bytes(saved_lock)
    return manifest


def run_owned(commands):
    processes = []
    started = time.monotonic()

    def cancelled(signum, _frame):
        raise SystemExit(128 + signum)

    handlers = {
        signum: signal.signal(signum, cancelled)
        for signum in (signal.SIGINT, signal.SIGTERM)
    }
    try:
        for name, command in commands:
            process = subprocess.Popen(command, start_new_session=True)
            processes.append((name, process))
            stamp(name + "_started", pid=process.pid)
        pending = list(processes)
        while pending:
            for name, process in pending[:]:
                result = process.poll()
                if result is not None:
                    stamp(
                        name + "_finished",
                        status=result,
                        seconds=round(time.monotonic() - started, 3),
                    )
                    if result:
                        raise subprocess.CalledProcessError(result, process.args)
                    pending.remove((name, process))
            if pending:
                time.sleep(0.2)
    finally:
        for _, process in processes:
            # Retire the whole owned group, including any still-running descendants.
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        for _, process in processes:
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
        for signum, handler in handlers.items():
            signal.signal(signum, handler)


def consume():
    started = time.monotonic()
    stamp("consumer_started")
    run_owned(
        [
            ("simulator", [sys.executable, "ios/scripts/preboot-simulator.py"]),
            ("products", [sys.executable, __file__, "fetch"]),
        ]
    )
    root = Path(os.environ["RUNNER_TEMP"])
    manifest = unpack(
        root / "ios-test-transfer",
        root / "okou-ios-ci",
        context(),
        read_inputs(),
        Path(
            "ios/Okou.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"
        ).read_bytes(),
    )
    diagnostics = root / "ios-two-mac-diagnostics"
    diagnostics.mkdir(exist_ok=True)
    (diagnostics / "transfer-manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n"
    )
    stamp("ready_for_tests", seconds=round(time.monotonic() - started, 3))
    run_owned([("tests", ["bash", "ios/scripts/ci-test.sh", "run"])])
    stamp("consumer_finished", seconds=round(time.monotonic() - started, 3))


if __name__ == "__main__":
    try:
        {"check-host": check_host, "pack": pack, "fetch": fetch, "consume": consume}[
            sys.argv[1]
        ]()
    except subprocess.CalledProcessError as error:
        raise SystemExit(
            error.returncode if error.returncode > 0 else 128 - error.returncode
        ) from error
