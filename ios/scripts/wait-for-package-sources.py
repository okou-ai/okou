#!/usr/bin/env python3
"""Wait for this run's successful source producer before downloading its artifact.

Requires gh, GH_TOKEN (actions:read), GITHUB_REPOSITORY, GITHUB_RUN_ID and
GITHUB_SHA. The existing Mac job deadline remains authoritative; this wait also
fails after ten minutes. A failed producer or unavailable API fails the caller.
"""

import argparse
import json
import os
import subprocess
import time


def pages(endpoint):
    return json.loads(
        subprocess.check_output(
            ["gh", "api", endpoint, "--paginate", "--slurp"], timeout=30
        )
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wait-seconds", type=int, default=600)
    args = parser.parse_args()
    repository = os.environ["GITHUB_REPOSITORY"]
    run_id = os.environ["GITHUB_RUN_ID"]
    source_sha = os.environ["GITHUB_SHA"]
    artifact_name = f"ios-package-sources-{source_sha}"
    root = f"repos/{repository}/actions/runs/{run_id}"
    started = time.monotonic()
    while True:
        # All attempts preserve a successful producer on a downstream-only rerun.
        # The latest producer wins when the producer itself is rerun.
        jobs = [
            job
            for page in pages(f"{root}/jobs?filter=all&per_page=100")
            for job in page["jobs"]
            if job["name"] == "prepare-package-sources"
        ]
        if jobs:
            producer = max(jobs, key=lambda job: job["id"])
            if producer["head_sha"] != source_sha:
                raise ValueError("Package producer belongs to a different revision")
            if producer["status"] == "completed":
                if producer["conclusion"] != "success":
                    raise ValueError(
                        f"Package producer did not succeed: {producer['conclusion']}"
                    )
                artifacts = [
                    artifact
                    for page in pages(
                        f"{root}/artifacts?name={artifact_name}&per_page=100"
                    )
                    for artifact in page["artifacts"]
                    if artifact["name"] == artifact_name
                ]
                if len(artifacts) > 1:
                    raise ValueError("Ambiguous package-source artifact")
                if artifacts:
                    if artifacts[0]["expired"]:
                        raise ValueError("Package-source artifact has expired")
                    print(
                        f"iOS package sources ready from job {producer['id']}; "
                        f"waited {time.monotonic() - started:.3f} seconds"
                    )
                    return
        if time.monotonic() - started >= args.wait_seconds:
            raise TimeoutError("Timed out waiting for successful package sources")
        time.sleep(1)


if __name__ == "__main__":
    main()
