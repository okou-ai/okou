#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/bin"
# Execute with only the operator's documented tools, matching the release
# toolchain's lack of GitHub CLI. External HTTP and the migration CLI are faked.
for tool in bash jq git mv touch; do
  ln -s "$(command -v "$tool")" "$work/bin/$tool"
done
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
if [[ "$*" == *https://api.github.com/* ]]; then
  jq -n --arg status "${WALLET_TEST_COMPARISON:-ahead}" '{status: $status}'
  exit "${WALLET_TEST_COMPARE_EXIT:-0}"
fi
deployment=fixture-serving
if [[ -f "$WALLET_TEST_DIR/executed" && "${WALLET_TEST_DRIFT:-false}" == "true" ]]; then
  deployment=fixture-replaced
fi
jq -n --arg deployment "$deployment" '{
  id: "fixture-project", accountId: "fixture-team",
  targets: {production: {id: $deployment, readyState: "READY", target: "production",
    alias: ["api.okou.ai"], meta: {githubCommitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}}
}'
SH
cat > "$work/bin/pnpm" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "$LINK_OAUTH_CLIENT_SECRET" == 'literal-$(not-a-command)-$NOT_EXPANDED' ]]
touch "$WALLET_TEST_DIR/executed"
mode=dry-run
for arg in "$@"; do
  if [[ "$arg" == "--migrate" ]]; then
    mode=migrate
    touch "$WALLET_TEST_DIR/migrated"
  fi
done
jq -n --arg mode "$mode" '{mode: $mode, completed: true, after: {legacy: 0, revokedLegacy: 0}}' > "$WALLET_GRANT_REPORT"
exit "${WALLET_TEST_EXIT:-0}"
SH
chmod +x "$work/bin/curl" "$work/bin/pnpm"

run() {
  rm -f "$work/executed" "$work/migrated" "$WALLET_GRANT_REPORT"
  (
    cd "$repo_root"
    PATH="$work/bin" bash ops/link-wallet-grants-40206/migrate.sh
  ) > "$work/output" 2>&1
}

run
jq -e '.mode == "dry-run" and .completed and .servingUnchanged and .serving.deploymentId == "fixture-serving"' "$WALLET_GRANT_REPORT" >/dev/null
[[ ! -f "$work/migrated" ]]

WALLET_GRANT_MIGRATE=true run
jq -e '.mode == "migrate" and .servingUnchanged' "$WALLET_GRANT_REPORT" >/dev/null
[[ -f "$work/migrated" ]]

if WALLET_TEST_COMPARISON=behind run; then
  echo "Expected old serving API to block migration" >&2
  exit 1
fi
[[ ! -f "$work/executed" ]]

if WALLET_TEST_COMPARE_EXIT=22 run; then
  echo "Expected failed serving ancestry lookup to block migration" >&2
  exit 1
fi
[[ ! -f "$work/executed" ]]

if WALLET_GRANT_MIGRATE=invalid run; then
  echo "Expected invalid mutation mode to block migration" >&2
  exit 1
fi
[[ ! -f "$work/executed" ]]

status=0
WALLET_GRANT_MIGRATE=true WALLET_TEST_EXIT=7 run || status=$?
[[ "$status" -eq 7 ]]
[[ -f "$work/migrated" ]]
jq -e '.servingUnchanged == false' "$WALLET_GRANT_REPORT" >/dev/null

if WALLET_TEST_DRIFT=true run; then
  echo "Expected a serving deployment change to invalidate acceptance" >&2
  exit 1
fi
jq -e '.servingUnchanged == false' "$WALLET_GRANT_REPORT" >/dev/null

printf '%s\n' 'invalid-secret-fragment' >> "$WEB_API_ENV_FILE"
if run; then
  echo "Expected malformed environment data to block migration" >&2
  exit 1
fi
[[ ! -f "$work/executed" ]]
if grep -q 'invalid-secret-fragment' "$work/output"; then
  echo "Environment data must not appear in diagnostics" >&2
  exit 1
fi
echo "Standalone Link wallet migration gates passed"
