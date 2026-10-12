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
dev = json.loads((root / ".devcontainer/devcontainer.json").read_text())
release = re.fullmatch(r"ghcr\.io/okou-ai/vm0-dev:([0-9]{8})", dev["image"])
assert release, "devcontainer must use a fixed published development release"
tag = release[1]
files = [root / ".devcontainer/devcontainer.json",
         root / ".github/scripts/runner-binary-build/contract.env",
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
