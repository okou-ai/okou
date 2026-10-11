#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: prepare-runner-wss.sh <user@host>" >&2
  exit 2
fi
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Supply the same standard-library preparer as Ansible. Binary/image cache
# hits never establish filesystem prerequisites or optional Caddy readiness.
ssh "$1" sudo /usr/bin/python3 - <"${repo_root}/ansible/scripts/prepare-runner-wss.py"
