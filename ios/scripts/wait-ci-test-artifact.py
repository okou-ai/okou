#!/usr/bin/env python3
"""Wait for a named producer's artifact in this run without allocating another job."""

import argparse
import hashlib
import http.client
import json
import os
import shutil
import tempfile
import time
import zipfile
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class HTTPSRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urlsplit(newurl).scheme != "https":
            raise ValueError("Artifact download requires an HTTPS redirect")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def github_api(path, *, output=None, timeout=30):
    api = os.environ.get("GITHUB_API_URL", "https://api.github.com")
    req = Request(
        f"{api.rstrip('/')}/{path}",
        headers={
            "User-Agent": "okou-ios-ci",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    # The signed artifact URL authenticates itself. Keep the GitHub token on
    # the original request, including when the artifact service redirects.
    req.add_unredirected_header("Authorization", "Bearer " + os.environ["GH_TOKEN"])
    opener = build_opener(HTTPSRedirect())
    for delay in (1, 2, 0):
        if output is not None:
            output.seek(0)
            output.truncate()
        try:
            with opener.open(req, timeout=timeout) as response:
                if output is None:
                    return response.read()
                shutil.copyfileobj(response, output, length=1024 * 1024)
                return None
        except HTTPError as exc:
            exc.close()
            if not delay or (exc.code != 429 and exc.code < 500):
                raise RuntimeError(f"GitHub returned HTTP {exc.code}") from None
        except (URLError, OSError, http.client.HTTPException) as exc:
            if not delay:
                raise RuntimeError(
                    f"GitHub transfer failed ({type(exc).__name__})"
                ) from None
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
    attempt = os.environ["GITHUB_RUN_ATTEMPT"]
    # Actions metadata records the PR tip. Checkout and artifact names use the merge SHA.
    pr_head = os.environ["PR_HEAD_SHA"]
    checkout = os.environ["GITHUB_SHA"]
    base = f"repos/{repo}/actions/runs/{run}"
    producer = "test-packages" if kind == "products" else "prepare-package-sources"
    name = (
        f"ios-ci-products-{checkout}-{attempt}"
        if kind == "products"
        else f"ios-package-sources-{checkout}"
    )
    params = urlencode({"name": name, "per_page": 100})
    deadline = time.monotonic() + (900 if kind == "products" else 300)
    while time.monotonic() < deadline:
        jobs = request(f"{base}/attempts/{attempt}/jobs?per_page=100")
        # Actions can briefly return null entries as jobs start.
        matching = [j for j in jobs["jobs"] if j and j["name"] == producer]
        if len(matching) > 1:
            raise ValueError("Ambiguous producer job")
        if matching:
            job = matching[0]
            if (
                job["head_sha"] != pr_head
                or str(job["run_id"]) != run
                or str(job["run_attempt"]) != attempt
            ):
                raise ValueError("Producer identity does not match this PR run attempt")
            items = request(f"{base}/artifacts?{params}")
            live = [
                a for a in items["artifacts"] if a["name"] == name and not a["expired"]
            ]
            if len(live) > 1:
                raise ValueError("Ambiguous input artifact")
            if live:
                origin = live[0]["workflow_run"]
                if str(origin["id"]) != run or origin["head_sha"] != pr_head:
                    raise ValueError("Artifact identity does not match this PR run")
                print(
                    f"Receiving {name} from {producer}, artifact {live[0]['id']}",
                    flush=True,
                )
                return live[0]
            # Package tests run after the product upload and have their own gate.
            if job["conclusion"] not in (None, "success"):
                raise ValueError(
                    f"{producer} ended with {job['conclusion']} before publishing {kind}"
                )
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
