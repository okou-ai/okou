#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

# Fixed workflow/devcontainer/build-contract references select one published release.
# The Docker PR builder's local vm0-dev:test output is not a consumer reference.
python3 - "$REPO_ROOT" <<'PY'
import json
from pathlib import Path
import re
import sys

root = Path(sys.argv[1])

# CI and local development inherit the same Docker Rust stage. Sandbox
# templates must select that exact release too; floating channels can drift
# even when every image reference below is pinned to one published release.
dockerfile = (root / "docker/toolchain/Dockerfile").read_text()
template = (root / "crates/runner/scripts/build-template.sh").read_text()
docker_rust = re.search(r"^ARG RUST_VERSION=([0-9]+\.[0-9]+\.[0-9]+)$", dockerfile, re.M)
template_rust = re.search(r'^RUST_VERSION="([0-9]+\.[0-9]+\.[0-9]+)"$', template, re.M)
assert docker_rust, "Docker toolchain must pin an exact Rust release"
assert template_rust, "sandbox template must pin an exact Rust release"
assert docker_rust[1] == template_rust[1], \
    f"sandbox Rust {template_rust[1]} differs from CI/development Rust {docker_rust[1]}"

dev = json.loads((root / ".devcontainer/devcontainer.json").read_text())
release = re.fullmatch(r"ghcr\.io/okou-ai/vm0-dev:([0-9]{8})", dev["image"])
assert release, "devcontainer must use a fixed published development release"
tag = release[1]
files = [root / ".devcontainer/devcontainer.json",
         root / ".github/scripts/runner/runner-binary-build/contract.env",
         *sorted((root / ".github/workflows").glob("*.yml"))]
families = set()
for path in files:
    for image, selected in re.findall(r"(vm0-toolchain-rust|vm0-toolchain|vm0-dev):([A-Za-z0-9_.-]+)", path.read_text()):
        if path.name == "docker-toolchain.yml" and (image, selected) == ("vm0-dev", "test"):
            continue
        assert selected == tag, f"{path.relative_to(root)} selects {image}:{selected}, expected {tag}"
        families.add(image)
assert families == {"vm0-toolchain", "vm0-toolchain-rust", "vm0-dev"}
PY

echo "toolchain-image-references-test: ok"
