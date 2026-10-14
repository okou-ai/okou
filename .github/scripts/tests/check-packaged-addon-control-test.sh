#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
python3 "$repo_root/.github/scripts/tests/check-packaged-addon-control-test.py" "$repo_root"
