#!/usr/bin/env python3
"""Wait for a named producer's artifact in this run without allocating another job."""

import argparse
import json
import os
import subprocess
import time
from pathlib import Path
from urllib.parse import urlencode


def request(path):
    for delay in (1, 2, 0):
        try:
            result = subprocess.run(
                ["gh", "api", path],
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
        except subprocess.TimeoutExpired:
            if not delay:
                raise
        else:
            if result.returncode == 0:
                return json.loads(result.stdout)
            transient = any(
                part in result.stderr
                for part in (
                    "HTTP 5",
                    "HTTP 429",
                    "timed out",
                    "connection reset",
                    "unexpected EOF",
                )
            )
            if not delay or not transient:
                raise RuntimeError(result.stderr.strip())
        time.sleep(delay)


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
                with Path(os.environ["GITHUB_OUTPUT"]).open("a") as out:
                    out.write(f"name={name}\n")
                return
        time.sleep(5)
    raise TimeoutError(f"{producer} did not publish {kind} before the wait limit")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kind", choices=("sources", "products"))
    wait(parser.parse_args().kind)
