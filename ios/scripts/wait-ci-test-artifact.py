#!/usr/bin/env python3
"""Wait for a named producer's artifact in this run without allocating another job."""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import time
import zipfile
from pathlib import Path
from urllib.parse import urlencode


def github_api(path, *, output=None, timeout=30):
    for delay in (1, 2, 0):
        try:
            if output is not None:
                output.seek(0)
                output.truncate()
            result = subprocess.run(
                ["gh", "api", path],
                stdout=output if output is not None else subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired:
            if not delay:
                raise
        else:
            if result.returncode == 0:
                return result.stdout
            error = result.stderr.decode(errors="replace")
            transient = any(
                part in error
                for part in (
                    "HTTP 5",
                    "HTTP 429",
                    "timed out",
                    "connection reset",
                    "unexpected EOF",
                )
            )
            if not delay or not transient:
                raise RuntimeError(error.strip())
        time.sleep(delay)


def request(path):
    return json.loads(github_api(path))


def receive_products(artifact, destination):
    repo = os.environ["GITHUB_REPOSITORY"]
    files = {
        "products.tar.zst",
        "product-identity",
        "product-toolchain.json",
        "Package.resolved.before",
        "package-sources.gitconfig",
    }
    destination.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryFile(dir=destination) as archive:
        github_api(
            f"repos/{repo}/actions/artifacts/{int(artifact['id'])}/zip",
            output=archive,
            timeout=300,
        )
        if archive.tell() != artifact["size_in_bytes"]:
            raise ValueError("Downloaded product archive has an unexpected size")
        archive.seek(0)
        if (
            "sha256:" + hashlib.file_digest(archive, "sha256").hexdigest()
            != artifact["digest"]
        ):
            raise ValueError("Downloaded product archive digest does not match GitHub")
        archive.seek(0)
        with zipfile.ZipFile(archive) as bundle:
            entries = bundle.namelist()
            if len(entries) != len(files) or set(entries) != files:
                raise ValueError("Unexpected product archive layout")
            for name in entries:
                with (
                    bundle.open(name) as source,
                    (destination / name).open("wb") as target,
                ):
                    shutil.copyfileobj(source, target, 1024 * 1024)
    print("Received and verified App test products", flush=True)


def wait(kind):
    repo = os.environ["GITHUB_REPOSITORY"]
    run = os.environ["GITHUB_RUN_ID"]
    head = os.environ["GITHUB_SHA"]
    base = f"repos/{repo}/actions/runs/{run}"
    producer = "test-packages" if kind == "products" else "prepare-package-sources"
    deadline = time.monotonic() + (900 if kind == "products" else 300)
    while time.monotonic() < deadline:
        jobs = request(base + "/jobs?filter=latest&per_page=100")
        if jobs["total_count"] > len(jobs["jobs"]):
            raise ValueError("Incomplete producer job inventory")
        matching = [j for j in jobs["jobs"] if j["name"] == producer]
        if len(matching) > 1:
            raise ValueError("Ambiguous producer job")
        if matching:
            job = matching[0]
            if job["conclusion"] not in (None, "success"):
                raise ValueError(f"{producer} ended with {job['conclusion']}")
            if job["head_sha"] != head or str(job["run_id"]) != run:
                raise ValueError("Producer identity does not match this run")
            name = (
                f"ios-ci-products-{head}-{job['run_attempt']}"
                if kind == "products"
                else f"ios-package-sources-{head}"
            )
            params = urlencode({"name": name, "per_page": 100})
            items = request(f"{base}/artifacts?{params}")
            live = [
                a for a in items["artifacts"] if a["name"] == name and not a["expired"]
            ]
            if len(live) > 1:
                raise ValueError("Ambiguous input artifact")
            if live:
                print(
                    f"Receiving {name} from {producer}, artifact {live[0]['id']}",
                    flush=True,
                )
                return live[0]
        time.sleep(5)
    raise TimeoutError(f"{producer} did not publish {kind} before the wait limit")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kind", choices=("sources", "products"))
    parser.add_argument("--download-dir", type=Path)
    args = parser.parse_args()
    if args.download_dir and args.kind != "products":
        parser.error("--download-dir requires products")
    artifact = wait(args.kind)
    if args.download_dir:
        receive_products(artifact, args.download_dir)
    else:
        with Path(os.environ["GITHUB_OUTPUT"]).open("a") as out:
            out.write(f"name={artifact['name']}\n")
