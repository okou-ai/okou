#!/usr/bin/env bash
# Read-only App rollback validation. Run from a full repository checkout.
# Required env: TARGET_COMMIT (exact artifact SHA), APP_VERSION_ID (CF UUID),
# CONFIRMED_COMPATIBLE=yes, GITHUB_REPOSITORY, GH_TOKEN, CLOUDFLARE_ACCOUNT_ID,
# CLOUDFLARE_API_TOKEN, VERCEL_ORG_ID, VERCEL_PROJECT_ID, VERCEL_TOKEN.
# Dependencies: bash, git, gh, curl, jq, python3, timeout. Emits JSON on stdout;
# diagnostics go to stderr. Missing/ambiguous evidence exits nonzero.
set -euo pipefail

fail() { echo "::error::$*" >&2; exit 1; }
for name in TARGET_COMMIT APP_VERSION_ID CONFIRMED_COMPATIBLE GITHUB_REPOSITORY GH_TOKEN \
  CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN VERCEL_ORG_ID VERCEL_PROJECT_ID VERCEL_TOKEN; do
  [[ -n "${!name:-}" ]] || fail "Missing required environment variable: $name"
done
[[ "$CONFIRMED_COMPATIBLE" == yes ]] || fail "Confirm App compatibility with the serving API, signed Telegram links, and bare Slack links."
[[ "$TARGET_COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail "target_commit must be an exact lowercase artifact SHA."
[[ "$APP_VERSION_ID" =~ ^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$ ]] || fail "app_version_id must be a Cloudflare version UUID."
[[ "$CLOUDFLARE_ACCOUNT_ID" =~ ^[0-9a-f]{32}$ ]] || fail "Invalid Cloudflare account ID."
[[ "$GITHUB_REPOSITORY" == okou-ai/okou ]] || fail "App rollback is only supported for okou-ai/okou."
[[ "$VERCEL_ORG_ID" =~ ^team_[a-zA-Z0-9]+$ && "$VERCEL_PROJECT_ID" =~ ^prj_[a-zA-Z0-9]+$ ]] || fail "Invalid Vercel project/team identity."

umask 077
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT
# Header files keep credentials out of process arguments and diagnostics.
printf 'Authorization: Bearer %s\n' "$CLOUDFLARE_API_TOKEN" > "$work_dir/cf-header"
printf 'Authorization: Bearer %s\n' "$VERCEL_TOKEN" > "$work_dir/vercel-header"
cf_base="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/okou-app-production"
cf_get() {
  curl -fsS --connect-timeout 10 --max-time 30 -H "@$work_dir/cf-header" "$cf_base/$1" \
    | jq -e 'if .success == true then .result else error("Cloudflare lookup failed") end'
}
vercel_get() {
  curl -fsS --connect-timeout 10 --max-time 30 -H "@$work_dir/vercel-header" \
    "https://api.vercel.com/$1?teamId=$VERCEL_ORG_ID"
}
github_get() { timeout 30 gh api "repos/$GITHUB_REPOSITORY/$1"; }
refresh_main() {
  timeout 60 git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main >&2
}

# The queue is owned by rollback-production.yml. Read current policy only after
# that queue, never from the selected historical target or marker creation date.
refresh_main
policy_main=$(git rev-parse origin/main)
floor=$(git show "$policy_main:.github/rollback-floors/telegram-settings-app")
[[ "$floor" =~ ^[0-9a-f]{40}$ ]] || fail "Missing or invalid explicit Telegram App floor."
git merge-base --is-ancestor "$floor" "$policy_main" || fail "App floor is not on main."
slack_floor=$(git show "$policy_main:.github/rollback-floors/slack-settings-app")
[[ "$slack_floor" =~ ^[0-9a-f]{40}$ ]] || fail "Missing or invalid explicit Slack App floor."
git merge-base --is-ancestor "$slack_floor" "$policy_main" || fail "Slack App floor is not on main."
# PR1 migrated App consumers off the legacy overview endpoints. Keep that
# preparation eligible independently of the later contract removal.
connector_resource_split_floor=$(git show "$policy_main:.github/rollback-floors/connector-resource-split") \
  || fail "Cannot read the Connector resource split rollback floor from main."
[[ "$connector_resource_split_floor" =~ ^[0-9a-f]{40}$ ]] || fail "Missing or invalid Connector resource split rollback floor."
git merge-base --is-ancestor "$connector_resource_split_floor" "$policy_main" || fail "Connector resource split rollback floor is not on main."
# Router serves only stateless MCP 2026-07-28. #43560 moved the Settings tool
# catalog request to that revision; earlier Apps cannot load the catalog.
data_router_mcp_floor=$(git show "$policy_main:.github/rollback-floors/data-router-stateless-mcp-app") \
  || fail "Cannot read the Data Router stateless MCP App rollback floor from main."
[[ "$data_router_mcp_floor" =~ ^[0-9a-f]{40}$ ]] || fail "Missing or invalid Data Router stateless MCP App rollback floor."
git merge-base --is-ancestor "$data_router_mcp_floor" "$policy_main" || fail "Data Router stateless MCP App rollback floor is not on main."
git cat-file -e "$TARGET_COMMIT^{commit}"
git merge-base --is-ancestor "$TARGET_COMMIT" "$policy_main" || fail "App artifact is not reachable from main."
git merge-base --is-ancestor "$floor" "$TARGET_COMMIT" || fail "App artifact predates the signed Telegram reader floor ($floor)."
git merge-base --is-ancestor "$slack_floor" "$TARGET_COMMIT" || fail "App artifact predates the authenticated bare Slack reader floor ($slack_floor)."

git merge-base --is-ancestor "$connector_resource_split_floor" "$TARGET_COMMIT" || fail "App artifact predates the Connector resource split ($connector_resource_split_floor)."
git merge-base --is-ancestor "$data_router_mcp_floor" "$TARGET_COMMIT" || fail "App artifact predates the Data Router stateless MCP catalog request ($data_router_mcp_floor)."

# Fail closed if a later release removes a retained reader or its entry point.
# Target source is data; no code from a rollback target is executed.
python3 - "$TARGET_COMMIT" "$slack_floor" <<'PY'
import re
import subprocess
import sys

sha = sys.argv[1]
def source(path, revision=sha):
    return subprocess.check_output(["git", "show", f"{revision}:{path}"], text=True)

bootstrap = source("turbo/apps/platform/src/signals/bootstrap.ts")
paths = source("turbo/apps/platform/src/signals/route-paths.ts")
canonical = source("turbo/packages/core/src/integration-routes.ts")
for route in ("settingsTelegram", "telegramConnect"):
    if not re.search(r"path:\s*ROUTES\." + route + r",\s*setup:\s*setupAuthPageWrapper\(setupTelegramConnectPage\$\)", bootstrap):
        sys.exit(f"Missing signed Telegram reader registration: {route}")
if not re.search(r'settingsTelegram:\s*INTEGRATION_SETTINGS_PATHS\.telegram', paths) or not re.search(r'telegramConnect:\s*"/telegram/connect"', paths) or not re.search(r'telegram:\s*"/settings/telegram"', canonical):
    sys.exit("Telegram signed reader paths do not match the supported contract")
if not re.search(r"path:\s*ROUTES\.settingsSlack,\s*setup:\s*setupAuthSidebarPageWrapper\(setupSlackConnectPage\$\)", bootstrap) or not re.search(r'import\s*\{\s*setupSlackConnectPage\$\s*\}\s*from\s*"\./okou-page/slack-connect-page\.ts"', bootstrap):
    sys.exit("Missing authenticated canonical Slack reader registration")
if not re.search(r'settingsSlack:\s*INTEGRATION_SETTINGS_PATHS\.slack', paths) or not re.search(r'slack:\s*"/settings/slack"', canonical):
    sys.exit("Slack reader path does not match the supported contract")

# Ancestry and path strings cannot prove that a descendant kept the bare reader.
# Require the reviewed signal/setup/view source: absent w/u reads slackOrgData$
# and renders overview actions. Any later reader edit needs a reviewed floor
# update; do not guess semantic equivalence or execute historical App code.
for path in (
    "turbo/apps/platform/src/signals/okou-page/slack-connect-signals.ts",
    "turbo/apps/platform/src/signals/okou-page/slack-connect-page.ts",
    "turbo/apps/platform/src/views/okou-page/slack-connect-page.tsx",
):
    if source(path) != source(path, sys.argv[2]):
        sys.exit(f"Slack reader differs from the reviewed floor; review compatibility before updating the floor: {path}")
PY

app_version=$(git show "$TARGET_COMMIT:turbo/apps/platform/package.json" | jq -er '.version')
[[ "$app_version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || fail "App artifact has no stable version."
release_tag="app-v$app_version"
release=$(github_get "releases/tags/$release_tag")
jq -e --arg tag "$release_tag" --arg sha "$TARGET_COMMIT" \
  '.tag_name == $tag and .target_commitish == $sha and .draft == false and .prerelease == false and (.published_at | type == "string")' \
  <<< "$release" >/dev/null || fail "App release identity is missing or mismatched."
timeout 60 git fetch --no-tags origin "refs/tags/$release_tag" >&2
[[ "$(git rev-parse 'FETCH_HEAD^{commit}')" == "$TARGET_COMMIT" ]] || fail "App release tag does not identify the artifact."

verify_cf_version() {
  local version
  version=$(cf_get "versions/$APP_VERSION_ID")
  jq -e --arg id "$APP_VERSION_ID" --arg message "app artifact $TARGET_COMMIT" \
    '.id == $id and .annotations["workers/message"] == $message' <<< "$version" >/dev/null \
    || fail "Cloudflare version/artifact annotation mismatch."
}
verify_cf_version

# A stored version is not proof of a successful deployment. Require its exact
# 100% CF deployment AND a successful GitHub App status for the artifact in
# that deployment's creation/success interval. An earlier success for the same
# artifact must not authorize a later failed deployment/version.
# Searches are bounded; older/unavailable evidence must be resolved, not guessed.
cf_deployment=
for page in {1..10}; do
  deployments=$(cf_get "deployments?per_page=100&page=$page")
  cf_deployment=$(jq -c --arg id "$APP_VERSION_ID" --arg message "app artifact $TARGET_COMMIT" \
    '[.deployments[] | select(.annotations["workers/message"] == $message and .versions == [{version_id: $id, percentage: 100}])][0] // empty' <<< "$deployments")
  [[ -z "$cf_deployment" ]] || break
  [[ "$(jq '.deployments | length' <<< "$deployments")" == 100 ]] || break
done
[[ -n "$cf_deployment" ]] || fail "No historical 100% Cloudflare deployment for this exact App artifact/version."
cf_deployment_id=$(jq -er '.id' <<< "$cf_deployment")
cf_deployed_at=$(jq -er '.created_on | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601' <<< "$cf_deployment") \
  || fail "Historical Cloudflare deployment has no valid creation time."

github_deployment_id=
for page in {1..10}; do
  deployments=$(github_get "deployments?environment=app%2Fproduction&per_page=100&page=$page")
  deployment_rows=$(jq -r 'if type == "array" then .[] | [.id, .created_at] | @tsv else error("Invalid GitHub deployments") end' <<< "$deployments")
  while IFS=$'\t' read -r deployment_id created_at; do
    [[ -n "$deployment_id" ]] || continue
    [[ "$deployment_id" =~ ^[0-9]+$ ]] || fail "Invalid GitHub deployment identity."
    started_at=$(jq -enr --arg date "$created_at" '$date | fromdateiso8601') \
      || fail "GitHub deployment has no valid creation time."
    (( started_at <= cf_deployed_at )) || continue
    statuses=$(github_get "deployments/$deployment_id/statuses?per_page=100")
    successful=$(jq -r --arg url "https://github.com/$GITHUB_REPOSITORY/commit/$TARGET_COMMIT/checks" \
      --argjson deployed_at "$cf_deployed_at" \
      'any(.[]; .state == "success" and .environment == "app/production" and .log_url == $url and
        (.created_at | fromdateiso8601) >= $deployed_at)' <<< "$statuses")
    if [[ "$successful" == true ]]; then
      github_deployment_id=$deployment_id
      break
    fi
  done <<< "$deployment_rows"
  [[ -z "$github_deployment_id" ]] || break
  [[ "$(jq length <<< "$deployments")" == 100 ]] || break
done
[[ -n "$github_deployment_id" ]] || fail "No successful GitHub App deployment for the artifact (deployment SHA is not artifact identity)."

# Query the authoritative production alias, not the newest build or main.
alias_json=$(vercel_get v4/aliases/api.okou.ai)
api_deployment_id=$(jq -er --arg project "$VERCEL_PROJECT_ID" \
  'select(.alias == "api.okou.ai" and .projectId == $project and .redirect == null and .microfrontends == null) | .deploymentId' <<< "$alias_json") || fail "Cannot resolve a trusted production API alias."
[[ "$api_deployment_id" =~ ^dpl_[a-zA-Z0-9]+$ ]] || fail "Cannot resolve the serving API deployment."
api_deployment=$(vercel_get "v13/deployments/$api_deployment_id")
api_sha=$(jq -er --arg id "$api_deployment_id" --arg project "$VERCEL_PROJECT_ID" \
  'select(.id == $id and .projectId == $project and .readyState == "READY" and .target == "production" and .meta.githubCommitOrg == "okou-ai" and .meta.githubCommitRepo == "okou") | .meta.githubCommitSha' <<< "$api_deployment") || fail "Cannot verify the serving API artifact identity/readiness."
[[ "$api_sha" =~ ^[0-9a-f]{40}$ ]] || fail "Serving API has no trustworthy artifact SHA."
git merge-base --is-ancestor "$api_sha" origin/main || fail "Serving API artifact is not reachable from main."
api_floor=$(git show "$api_sha:turbo/apps/api/src/lib/web-client-compatibility.json" | jq -er '.minimumSupportedVersion') || fail "Cannot read the serving API App floor."
python3 - "$app_version" "$api_floor" <<'PY'
import re
import sys
app, floor = sys.argv[1:]
if not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", floor):
    sys.exit("Serving API has no valid App version floor")
if tuple(map(int, app.split('.'))) < tuple(map(int, floor.split('.'))):
    sys.exit(f"App {app} is below serving API floor {floor}")
PY

# Refresh policy and serving identity immediately before returning to the
# mutation helper. A queue wait/build/policy change cannot reuse old evidence.
refresh_main
git diff --quiet "$policy_main" origin/main -- .github/rollback-floors/telegram-settings-app \
  .github/rollback-floors/slack-settings-app .github/rollback-floors/connector-resource-split \
  .github/rollback-floors/data-router-stateless-mcp-app \
  .github/scripts/release/resolve-app-rollback-target.sh .github/scripts/release/rollback-app-production.sh \
  .github/workflows/rollback-production.yml || fail "App rollback policy changed during validation; rerun from current main."
git diff --quiet HEAD origin/main -- .github/scripts/release/resolve-app-rollback-target.sh \
  .github/scripts/release/rollback-app-production.sh || fail "App rollback tooling is stale; rerun from current main."
verify_cf_version
current_alias=$(vercel_get v4/aliases/api.okou.ai)
jq -e --arg id "$api_deployment_id" --arg project "$VERCEL_PROJECT_ID" \
  '.deploymentId == $id and .projectId == $project and .alias == "api.okou.ai" and .redirect == null and .microfrontends == null' \
  <<< "$current_alias" >/dev/null || fail "Serving API changed during App validation; rerun."
jq -n --arg artifact "$TARGET_COMMIT" --arg version "$APP_VERSION_ID" --arg app "$app_version" \
  --arg floor "$floor" --arg slack_floor "$slack_floor" --arg api_floor "$api_floor" --arg api_sha "$api_sha" --arg api_deployment "$api_deployment_id" \
  --arg cf_deployment "$cf_deployment_id" --arg github_deployment "$github_deployment_id" \
  '{artifact_sha:$artifact, version_id:$version, app_version:$app, reader_floor:$floor, slack_reader_floor:$slack_floor, api_floor:$api_floor,
    api_sha:$api_sha, api_deployment_id:$api_deployment, cf_deployment_id:$cf_deployment, github_deployment_id:$github_deployment}'
