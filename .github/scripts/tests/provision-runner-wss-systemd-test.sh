#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
for tool in python3 sudo systemctl systemd-run; do
  command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 1; }
done

# Run against a real manager/kernel, not a stub or syntax parser. The fixture
# loads only unique test-unit names and binds private runtime/account files.
sudo -n "$(command -v python3)" \
  "$repo_root/.github/scripts/tests/fixtures/provision-runner-wss-systemd.py" \
  "$repo_root"

echo "provision-runner-wss-systemd-test: ok"
