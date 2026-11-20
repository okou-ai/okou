#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
security_workflow="${repo_root}/.github/workflows/security.yml"
ssh_action="${repo_root}/.github/actions/setup-ssh-tunnel/action.yml"
stripe_installer="${repo_root}/e2e/scripts/ensure-stripe-cli.sh"

assert_contains() {
  local file="$1"
  local expected="$2"
  if ! grep -Fq -- "$expected" "$file"; then
    echo "Expected $file to contain: $expected" >&2
    exit 1
  fi
}

assert_not_contains() {
  local file="$1"
  local unexpected="$2"
  if grep -Fq -- "$unexpected" "$file"; then
    echo "Expected $file not to contain: $unexpected" >&2
    exit 1
  fi
}

assert_not_contains "$security_workflow" "| tar xz -C /usr/local/bin gitleaks"

assert_contains "$ssh_action" "bash \"\$GITHUB_WORKSPACE/.github/scripts/download-verified.sh\""

assert_contains "$stripe_installer" "bash \"\$download_script\""

assert_contains "$security_workflow" ".github/scripts/download-verified.sh"

echo "release tool download wiring tests passed"
