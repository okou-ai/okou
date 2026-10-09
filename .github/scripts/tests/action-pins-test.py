#!/usr/bin/env python3
"""Require every external action to use its approved repository-wide SHA."""

import json
from pathlib import Path
import re
import subprocess
import sys

# Upgrade this allowlist and every workflow/composite reference in the same PR.
# Action subpaths are explicit so a new action needs approval, even in a known repo.
APPROVED_ACTIONS = {
    "actions/checkout": "3d3c42e5aac5ba805825da76410c181273ba90b1",  # v7.0.1
    "actions/create-github-app-token": "bcd2ba49218906704ab6c1aa796996da409d3eb1",  # v3.2.0
    "actions/download-artifact": "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",  # v8.0.1
    "actions/github-script": "3a2844b7e9c422d3c10d287c895573f7108da1b3",  # v9.0.0
    "actions/setup-node": "820762786026740c76f36085b0efc47a31fe5020",  # v7.0.0
    "actions/setup-python": "5fda3b95a4ea91299a34e894583c3862153e4b97",  # v7
    "actions/upload-artifact": "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",  # v7.0.1
    "astral-sh/setup-uv": "c18668ad3cf93ea998bef934396af7bb5c839dc7",  # v10.2.0
    "bobheadxi/deployments": "648679e8e4915b27893bd7dbc35cb504dc915bc8",  # v1
    "codecov/codecov-action": "303a32d7a59b442fa8d48b6a1cc6825c09c847a5",  # v7.1.1
    "docker/build-push-action": "c3c9e263c25d99ce0380d002d59b67737d91b0dc",  # v7.4.0
    "docker/login-action": "dbcb813823bdd20940b903addbd779551569679f",  # v4.6.0
    "docker/setup-buildx-action": "f87e5991a6d7451dcb8d9637bfbc97413f497069",  # v4.4.1
    "dopplerhq/secrets-fetch-action": "451892f16195f9ac360e1a5bcbf0b5fd0e957534",  # v2.0.0
    "github/codeql-action/analyze": "2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2",  # v4.38.2
    "github/codeql-action/init": "2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2",  # v4.38.2
    "github/codeql-action/upload-sarif": "2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2",  # v4.38.2
    "marocchino/sticky-pull-request-comment": "5770ad5eb8f42dd2c4f34da00c94c5381e49af88",  # v3.0.5
    "mozilla-actions/sccache-action": "fc920bf0ec8de6ee65d409111f7ec508035751ba",  # v0.0.11
    "okou-ai/release-please-action": "420308b1502ae6728b0654ceb84f863eedf8e621",
    "pnpm/action-setup": "ea17c68df8912ef543352723c149a84f56e3d413",  # v6.1.0
    "slackapi/slack-github-action": "dcb1066f776dd043e64d0e8ba94ca15cc7e1875d",  # v4.0.0
    "swatinem/rust-cache": "6323deb102c322ba6fcbdcafc7e3dddab59af2b6",  # v2.9.2
    "taiki-e/install-action": "183e4297cca2404691e9380e1307288dced5c82a",  # v2.87.25
}
SHA_PATTERN = re.compile(r"[0-9a-f]{40}")


def action_id(value):
    parts = value.split("/")
    return "/".join([part.lower() for part in parts[:2]] + parts[2:])


def references(document):
    def steps(items, location):
        for index, step in enumerate(items):
            step_location = f"{location}[{index}]"
            if "uses" in step:
                yield step["uses"], step_location, "./.github/actions/"
            yield from steps(step.get("parallel", []), f"{step_location}.parallel")

    for job_id, job in document.get("jobs", {}).items():
        if "uses" in job:
            yield job["uses"], f"jobs.{job_id}", "./.github/workflows/"
        yield from steps(job.get("steps", []), f"jobs.{job_id}.steps")
    yield from steps(document.get("runs", {}).get("steps", []), "runs.steps")


def check(root):
    errors = []
    repository_shas = {}
    for action, sha in APPROVED_ACTIONS.items():
        if action_id(action) != action or not SHA_PATTERN.fullmatch(sha):
            errors.append(f"invalid allowlist entry: {action}@{sha}")
        repository = "/".join(action.split("/")[:2])
        previous = repository_shas.setdefault(repository, sha)
        if previous != sha:
            errors.append(f"allowlist uses multiple SHAs for {repository}")

    workflows = root / ".github/workflows"
    files = sorted([*workflows.glob("*.yml"), *workflows.glob("*.yaml")])
    if not files:
        errors.append(f"no workflow files found in {workflows}")
    actions = root / ".github/actions"
    files += sorted([*actions.rglob("action.yml"), *actions.rglob("action.yaml")])
    external_count = 0
    for path in files:
        result = subprocess.run(
            ["yq", "-o=json", ".", str(path)], capture_output=True, text=True
        )
        if result.returncode:
            errors.append(f"{path.relative_to(root)}: cannot parse YAML: {result.stderr.strip()}")
            continue
        document = json.loads(result.stdout)
        for value, location, local_prefix in references(document):
            source = f"{path.relative_to(root)}:{location}.uses"
            if not isinstance(value, str):
                errors.append(f"{source}: action reference must be a string")
                continue
            if value.startswith(local_prefix) and ".." not in value.split("/") and "@" not in value:
                continue
            action, separator, sha = value.rpartition("@")
            if not separator or not SHA_PATTERN.fullmatch(sha):
                errors.append(f"{source}: must use a full 40-character commit SHA: {value}")
                continue
            external_count += 1
            approved = APPROVED_ACTIONS.get(action_id(action))
            if approved is None:
                errors.append(f"{source}: action is not in the allowlist: {action}")
            elif sha != approved:
                errors.append(f"{source}: {action} must use {approved}, got {sha}")
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print(f"action-pins-test: {external_count} external references in {len(files)} files passed")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: action-pins-test.py <repository-root>")
    sys.exit(check(Path(sys.argv[1]).resolve()))
