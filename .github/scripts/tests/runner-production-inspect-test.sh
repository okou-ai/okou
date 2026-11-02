#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
python3 -B -m unittest discover -s "$repo_root/ops/runner-production-inspect" -p 'test_*.py'
