#!/usr/bin/env bash
set -euo pipefail
repo_root="$(git rev-parse --show-toplevel)"
python3 -I -B "$repo_root/.github/scripts/tests/fixtures/home_image_cache_collector_tests.py"
