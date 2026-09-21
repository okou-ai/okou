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

if [[ "$(grep -Fc 'bash .github/scripts/download-verified.sh' "$security_workflow")" != "4" ]]; then
  echo "Expected all security tool installers to use download-verified.sh" >&2
  exit 1
fi
assert_contains "$security_workflow" "ACTIONLINT_VERSION=1.7.12"
assert_contains "$security_workflow" "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8"
assert_contains "$security_workflow" "RIPGREP_VERSION=14.1.1"
assert_contains "$security_workflow" "4cf9f2741e6c465ffdb7c26f38056a59e2a2544b51f7cc128ef28337eeae4d8e"
assert_contains "$security_workflow" "GITLEAKS_VERSION=8.30.1"
assert_contains "$security_workflow" "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
assert_not_contains "$security_workflow" "download-actionlint.bash"
assert_not_contains "$security_workflow" "| tar xz -C /usr/local/bin gitleaks"

assert_contains "$ssh_action" 'CLOUDFLARED_VERSION=2026.6.0'
assert_contains "$ssh_action" "bash \"\$GITHUB_WORKSPACE/.github/scripts/download-verified.sh\""
assert_contains "$ssh_action" "0f8d62a84cdf9474409a486d62c9269d9a4b28665d2c4e675cb87c062395d3f7"
assert_contains "$ssh_action" "b0bcc293670cafd150380efebea85073424e332f136003ae9fdf99b2c83a0231"
assert_not_contains "$ssh_action" "cloudflared-version:"

assert_contains "$stripe_installer" 'version="1.41.2"'
assert_contains "$stripe_installer" "bash \"\$download_script\""
assert_contains "$stripe_installer" "35684521fc6c2d994e6461ef28330f2c77fbf7d588a7b93fee5e8d4aa52d0c65"
assert_contains "$stripe_installer" "04d86663e840ec1fc71ec0f1ccceb9345a5bd783614746f590b05e4bf1f61b9b"
assert_not_contains "$stripe_installer" "STRIPE_CLI_VERSION"

assert_contains "$stripe_playbook" "stripe_cli_version: \"1.41.2\""
assert_contains "$stripe_playbook" "35684521fc6c2d994e6461ef28330f2c77fbf7d588a7b93fee5e8d4aa52d0c65"
assert_contains "$stripe_playbook" "04d86663e840ec1fc71ec0f1ccceb9345a5bd783614746f590b05e4bf1f61b9b"
assert_contains "$stripe_playbook" "command: uname -m"
assert_contains "$stripe_playbook" "stripe_cli_architecture.stdout in stripe_cli_architecture_aliases"
assert_contains "$stripe_playbook" "amd64: x86_64"
assert_contains "$stripe_playbook" "arm64: aarch64"
assert_contains "$stripe_playbook" "get_url:"
assert_contains "$stripe_playbook" 'checksum: "sha256:{{ stripe_cli_asset.sha256 }}"'
assert_contains "$stripe_playbook" "until: stripe_cli_download is succeeded"
assert_contains "$stripe_playbook" "retries: 3"
assert_contains "$stripe_playbook" "unarchive:"

download_line="$(grep -n -m 1 'get_url:' "$stripe_playbook" | cut -d : -f 1)"
extract_line="$(grep -n -m 1 'unarchive:' "$stripe_playbook" | cut -d : -f 1)"
if ((download_line >= extract_line)); then
  echo "Expected Stripe CLI extraction to follow the validated download" >&2
  exit 1
fi

assert_contains "$security_workflow" ".github/scripts/download-verified.sh"
assert_contains "$security_workflow" ".github/scripts/tests/download-verified-test.sh"
assert_contains "$security_workflow" ".github/scripts/tests/release-tool-downloads-test.sh"
assert_contains "$security_workflow" "e2e/scripts/ensure-stripe-cli.sh"

echo "release tool download wiring tests passed"
