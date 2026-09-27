#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
if [[ -n "${CADDY_BIN:-}" ]]; then
  python3 "${repo_root}/ansible/tests/test_runner_wss_caddy.py"
  exit 0
fi

# Official v2.11.4 release asset digest from GitHub's release metadata.
# Test runtime artifact only: do not install a system package or start a service.
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT
curl --fail --location --silent --show-error --retry 2 \
  'https://github.com/caddyserver/caddy/releases/download/v2.11.4/caddy_2.11.4_linux_amd64.tar.gz' \
  --output "${test_dir}/caddy.tar.gz"
printf '%s  %s\n' \
  '527fbf917c39189a1e3b31d34fa955601680b2d5c8055d2a87b8b9588dec7bb9' \
  "${test_dir}/caddy.tar.gz" | sha256sum --check --status
tar -xzf "${test_dir}/caddy.tar.gz" -C "$test_dir" caddy
CADDY_BIN="${test_dir}/caddy" python3 "${repo_root}/ansible/tests/test_runner_wss_caddy.py"
