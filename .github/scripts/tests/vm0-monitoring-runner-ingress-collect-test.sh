#!/usr/bin/env bash
set -euo pipefail
repo_root="$(git rev-parse --show-toplevel)"
python3 -I -B "$repo_root/ansible/tests/runner-ingress-collect-test.py"
