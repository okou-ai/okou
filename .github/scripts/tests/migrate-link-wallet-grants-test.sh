#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/bin"
export PATH="$work/bin:$PATH"
export WALLET_TEST_DIR="$work"
export VERCEL_TOKEN=fixture-token VERCEL_ORG_ID=fixture-team VERCEL_PROJECT_ID=fixture-project
export GH_TOKEN=fixture-github GITHUB_REPOSITORY=okou-ai/okou
export WEB_API_ENV_FILE="$work/api.env" WALLET_GRANT_REPORT="$work/report.json"
cat > "$WEB_API_ENV_FILE" <<'ENV_FILE'
ENV=production
LINK_OAUTH_CLIENT_SECRET=literal-$(not-a-command)-$NOT_EXPANDED
ENV_FILE

cat > "$work/bin/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
deployment=fixture-serving
if [[ -f "$WALLET_TEST_DIR/migrated" && "${WALLET_TEST_DRIFT:-false}" == "true" ]]; then
  deployment=fixture-replaced
fi
jq -n --arg deployment "$deployment" '{
  id: "fixture-project", accountId: "fixture-team",
  targets: {production: {id: $deployment, readyState: "READY", target: "production",
    alias: ["api.okou.ai"], meta: {githubCommitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}}
}'
SH
cat > "$work/bin/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "${WALLET_TEST_COMPARISON:-ahead}"
SH
cat > "$work/bin/pnpm" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "$LINK_OAUTH_CLIENT_SECRET" == 'literal-$(not-a-command)-$NOT_EXPANDED' ]]
touch "$WALLET_TEST_DIR/migrated"
printf '%s\n' '{"completed":true,"after":{"legacy":0,"revokedLegacy":0}}' > "$WALLET_GRANT_REPORT"
exit "${WALLET_TEST_EXIT:-0}"
SH
chmod +x "$work/bin/"*

run() {
  rm -f "$work/migrated" "$WALLET_GRANT_REPORT"
  bash "$repo_root/.github/scripts/release/migrate-link-wallet-grants.sh" > "$work/output" 2>&1
}

run
jq -e '.completed and .servingUnchanged and .serving.deploymentId == "fixture-serving"' "$WALLET_GRANT_REPORT" >/dev/null

if WALLET_TEST_COMPARISON=behind run; then
  echo "Expected old serving API to block migration" >&2
  exit 1
fi
[[ ! -f "$work/migrated" ]]

status=0
WALLET_TEST_EXIT=7 run || status=$?
[[ "$status" -eq 7 ]]
[[ -f "$work/migrated" ]]
jq -e '.servingUnchanged == false' "$WALLET_GRANT_REPORT" >/dev/null

if WALLET_TEST_DRIFT=true run; then
  echo "Expected a serving deployment change to block promotion" >&2
  exit 1
fi
jq -e '.servingUnchanged == false' "$WALLET_GRANT_REPORT" >/dev/null

printf '%s\n' 'invalid-secret-fragment' >> "$WEB_API_ENV_FILE"
if run; then
  echo "Expected malformed environment data to block migration" >&2
  exit 1
fi
[[ ! -f "$work/migrated" ]]
if grep -q 'invalid-secret-fragment' "$work/output"; then
  echo "Environment data must not appear in diagnostics" >&2
  exit 1
fi
echo "Link wallet release migration gates passed"
