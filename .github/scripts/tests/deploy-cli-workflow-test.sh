#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
workflow="${repo_root}/.github/workflows/turbo.yml"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

job_block() {
  local job_name="$1"
  awk -v job_name="$job_name" '
    $0 == "  " job_name ":" { in_job = 1 }
    in_job && $0 ~ /^  [a-zA-Z0-9_-]+:$/ && $0 != "  " job_name ":" { exit }
    in_job { print }
  ' "$workflow"
}

deploy_api="$(job_block deploy-api)"
deploy_cli="$(job_block deploy-cli)"

grep -Fq '    needs: [prepare]' <<<"$deploy_api" ||
  fail "deploy-api must depend on prepare"
if grep -Fq 'deploy-cli' <<<"$deploy_api"; then
  fail "deploy-api must not wait for deploy-cli"
fi

expected_package_url="cli-pkg-url: https://static.okou.io/okou-cli/\${{ github.sha }}/package.tgz"
package_url_count="$(grep -Fc "$expected_package_url" <<<"$deploy_api" || true)"
[[ "$package_url_count" == "2" ]] ||
  fail "API seed and deploy environments must derive the CLI package URL from the artifact SHA"

grep -Fq '      - name: Initialize pnpm cache directory' <<<"$deploy_cli" ||
  fail "deploy-cli must initialize the pnpm cache directory"
grep -Fq "        run: mkdir -p \"\$(pnpm store path --silent)\"" <<<"$deploy_cli" ||
  fail "deploy-cli must create the pnpm store before setup-node saves it"

smoke_count="$(grep -Fc 'bash .github/scripts/smoke-okou-cli-artifact.sh' <<<"$deploy_cli" || true)"
[[ "$smoke_count" == "2" ]] ||
  fail "deploy-cli must smoke both the local and CDN CLI artifacts"

echo "deploy-cli-workflow tests passed"
