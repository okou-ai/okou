#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
security_workflow="${repo_root}/.github/workflows/security.yml"
ssh_action="${repo_root}/.github/actions/setup-ssh-tunnel/action.yml"
stripe_installer="${repo_root}/e2e/scripts/ensure-stripe-cli.sh"
stripe_playbook="${repo_root}/ansible/playbooks/start-stripe-listener.yml"

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

assert_contains "$stripe_playbook" "stripe_cli_architecture.stdout in stripe_cli_architecture_aliases"
assert_contains "$stripe_playbook" "get_url:"
assert_contains "$stripe_playbook" 'checksum: "sha256:{{ stripe_cli_asset.sha256 }}"'
assert_contains "$stripe_playbook" "until: stripe_cli_download is succeeded"
if ! grep -Eq '^[[:space:]]+retries: [1-9][0-9]*$' "$stripe_playbook"; then
  echo "Stripe CLI downloads must have a finite positive retry count" >&2
  exit 1
fi
assert_contains "$stripe_playbook" "unarchive:"

download_line="$(grep -n -m 1 'get_url:' "$stripe_playbook" | cut -d : -f 1)"
extract_line="$(grep -n -m 1 'unarchive:' "$stripe_playbook" | cut -d : -f 1)"
if ((download_line >= extract_line)); then
  echo "Expected Stripe CLI extraction to follow the validated download" >&2
  exit 1
fi

assert_contains "$security_workflow" ".github/scripts/download-verified.sh"

echo "release tool download wiring tests passed"
