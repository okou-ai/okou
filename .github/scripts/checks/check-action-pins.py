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
    "actions/cache": "55cc8345863c7cc4c66a329aec7e433d2d1c52a9",  # v6.1.0
    "actions/cache/restore": "55cc8345863c7cc4c66a329aec7e433d2d1c52a9",  # v6.1.0
    "actions/cache/save": "55cc8345863c7cc4c66a329aec7e433d2d1c52a9",  # v6.1.0
    "actions/checkout": "3d3c42e5aac5ba805825da76410c181273ba90b1",  # v7.0.1
    "actions/create-github-app-token": "64ab729a6294000f5aa4a4bc0b73d1f32bc45510",  # v3.3.0
    "actions/download-artifact": "9000827ccba6bdab643e8b6fd33ac0654aef8333",  # v8.0.2
    "actions/github-script": "3a2844b7e9c422d3c10d287c895573f7108da1b3",  # v9.0.0
    "actions/setup-node": "949feb2413d6458794dcd2491c4babbbce0c15c1",  # v7.1.0
    "actions/setup-python": "6d4fd22b20465ccc0f7354476588e8df7c9ca0e0",  # v7
    "actions/upload-artifact": "cf430e030ddbb5b0abf93d22962f4752f3646cd9",  # v7.0.2
    "astral-sh/setup-uv": "68559e99cc807c1eb7e9238fd43a15bba460eec2",  # v10.3.3
    "bobheadxi/deployments": "648679e8e4915b27893bd7dbc35cb504dc915bc8",  # v1
    "codecov/codecov-action": "303a32d7a59b442fa8d48b6a1cc6825c09c847a5",  # v7.1.1
    "docker/build-push-action": "c3c9e263c25d99ce0380d002d59b67737d91b0dc",  # v7.4.0
    "docker/login-action": "81c6f93d4bc991e510b342a00b419b3bb4efc5c6",  # v4.7.0
    "docker/setup-buildx-action": "f87e5991a6d7451dcb8d9637bfbc97413f497069",  # v4.4.1
    "dopplerhq/secrets-fetch-action": "451892f16195f9ac360e1a5bcbf0b5fd0e957534",  # v2.0.0
    "github/codeql-action/analyze": "9b3254085494b55a0f7c4c2b3d2d52cc712ce370",  # v4.39.1
    "github/codeql-action/init": "9b3254085494b55a0f7c4c2b3d2d52cc712ce370",  # v4.39.1
    "github/codeql-action/upload-sarif": "9b3254085494b55a0f7c4c2b3d2d52cc712ce370",  # v4.39.1
    "marocchino/sticky-pull-request-comment": "5770ad5eb8f42dd2c4f34da00c94c5381e49af88",  # v3.0.5
    "okou-ai/release-please-action": "9d88edc37d41b22dcc46ab3fb56f19aec0e8b3d2",  # v5.0.0-okou
    "pnpm/action-setup": "ea17c68df8912ef543352723c149a84f56e3d413",  # v6.1.0
    "slackapi/slack-github-action": "dcb1066f776dd043e64d0e8ba94ca15cc7e1875d",  # v4.0.0
    "swatinem/rust-cache": "d1527c8f67ef9af357290475d4af4b0fab8f12e0",  # v2.9.3
    "taiki-e/install-action": "86f7a0ffb25f40114606501a311ebcfaf882ea32",  # v2.88.0
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
    print(f"check-action-pins: {external_count} external references in {len(files)} files passed")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: check-action-pins.py <repository-root>")
    sys.exit(check(Path(sys.argv[1]).resolve()))
