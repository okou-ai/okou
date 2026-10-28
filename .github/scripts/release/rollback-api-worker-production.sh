#!/usr/bin/env bash
# Paired API rollback adapter; run from the current main checkout, after Vercel.
# Requires TARGET_COMMIT, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, curl and jq.
# Optional GITHUB_OUTPUT/GITHUB_STEP_SUMMARY receive the result even on failure.
# Selects an exact SHA tag from Cloudflare's deployable history (last 100 versions).
# No rebuild, nearby-SHA fallback, resource/settings changes, or mutation retries.
# Exits nonzero for missing versions, deployment failures or verification failures;
# the workflow owns the explicitly non-blocking policy for this auxiliary Worker.
set -euo pipefail
umask 077
work_dir=$(mktemp -d)
worker_url=https://okou-api-production.vm0.workers.dev
worker_status=failed
worker_detail='Worker rollback did not complete; inspect the workflow logs.'
version_id=unavailable
deployment_id=unavailable
observed_sha=unavailable

report() {
  local exit_status=$?
  trap - EXIT
  if [ "$exit_status" -ne 0 ]; then
    echo "::warning::API Worker rollback: $worker_detail The canonical Vercel API rollback is not blocked."
  fi
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    {
      printf 'status=%s\ndetail=%s\n' "$worker_status" "$worker_detail"
      printf 'version-id=%s\ndeployment-id=%s\n' "$version_id" "$deployment_id"
      printf 'observed-sha=%s\nworker-url=%s\n' "$observed_sha" "$worker_url"
    } >> "$GITHUB_OUTPUT"
  fi
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      printf '### Paired API Worker rollback: %s\n\n%s\n\n' "$worker_status" "$worker_detail"
      printf "* Worker: %s\n* Target SHA: \`%s\`\n" "$worker_url" "${TARGET_COMMIT:-unavailable}"
      printf "* Version: \`%s\`\n* Deployment: \`%s\`\n* Observed SHA: \`%s\`\n" "$version_id" "$deployment_id" "$observed_sha"
    } >> "$GITHUB_STEP_SUMMARY"
  fi
  rm -rf "$work_dir"
  exit "$exit_status"
}
trap 'report' EXIT

fail() {
  worker_status=$1
  worker_detail=$2
  exit 1
}

[[ "${TARGET_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || fail failed 'Target must be a full lowercase release SHA.'
[[ "${CLOUDFLARE_ACCOUNT_ID:-}" =~ ^[0-9a-f]{32}$ ]] || fail failed 'Missing or invalid Cloudflare account ID.'
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || fail failed 'Missing Cloudflare API token.'
printf 'Authorization: Bearer %s\n' "$CLOUDFLARE_API_TOKEN" > "$work_dir/cf-header"
cf_base="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/okou-api-production"

cf_request() {
  local method=$1 route=$2 output=$3
  local args=()
  if [ "$method" = POST ]; then
    args=(--data-binary "@$work_dir/request.json")
  fi
  # Raw provider/curl diagnostics can contain credentials. Keep them private.
  if ! curl -fsS --connect-timeout 10 --max-time 30 \
    -H "@$work_dir/cf-header" -H 'Content-Type: application/json' \
    --request "$method" "${args[@]}" "$cf_base/$route" \
    > "$output" 2> "$work_dir/curl-error"; then
    if [ "$method" = POST ]; then
      fail uncertain 'Cloudflare deployment response was lost or failed; the write may have applied. Inspect the current deployment before retrying. No mutation was retried.'
    fi
    fail failed "Cloudflare $method ${route%%\?*} failed; inspect current deployment before retrying. No mutation was retried."
  fi
  if ! jq -e '.success == true' "$output" > /dev/null 2>&1; then
    fail failed "Cloudflare rejected $method ${route%%\?*}; inspect current deployment before retrying. No mutation was retried."
  fi
}

# deployable=true returns all deployable versions, ignoring pagination, as used
# by Wrangler. Ordinary versions list defaults to only a small recent page.
cf_request GET 'versions?deployable=true' "$work_dir/versions.json"
jq -e '.result.items | type == "array"' "$work_dir/versions.json" > /dev/null \
  || fail failed 'Cloudflare returned an invalid deployable version inventory.'
jq --arg sha "$TARGET_COMMIT" '
  [.result.items[] | select(.annotations["workers/tag"] == $sha)]
' "$work_dir/versions.json" > "$work_dir/matches.json"
match_count=$(jq length "$work_dir/matches.json")
if [ "$match_count" -eq 0 ]; then
  fail missing-version 'No deployable Worker version has the exact release SHA tag (failed deployment, untagged legacy version, or expired history). Worker left unchanged; no rebuild or nearby release selected.'
fi
# Reruns can share a source SHA but have different secrets or bindings. Like
# Wrangler tag selection, refuse ambiguity rather than guessing a version.
if [ "$match_count" -ne 1 ]; then
  fail ambiguous-version 'Multiple deployable Worker versions have the release SHA tag. Worker left unchanged; no version was guessed.'
fi
version_id=$(jq -r '.[0].id // empty' "$work_dir/matches.json")
if [[ ! "$version_id" =~ ^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$ ]]; then
  version_id=unavailable
  fail failed 'Cloudflare returned an invalid Worker version ID.'
fi

jq -n --arg version "$version_id" --arg sha "$TARGET_COMMIT" '
  {strategy:"percentage", versions:[{version_id:$version, percentage:100}],
   annotations:{"workers/message":("Paired API rollback to " + $sha)}}
' > "$work_dir/request.json"
cf_request POST deployments "$work_dir/response.json"
deployment_id=$(jq -r '.result.id // empty' "$work_dir/response.json")
if [[ ! "$deployment_id" =~ ^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$ ]]; then
  deployment_id=unavailable
  fail failed 'Cloudflare did not confirm a deployment ID; inspect before retrying.'
fi
cf_request GET deployments "$work_dir/readback.json"
jq -e --arg deployment "$deployment_id" --arg version "$version_id" '
  .result.deployments[0].id == $deployment and
  .result.deployments[0].versions == [{version_id:$version, percentage:100}]
' "$work_dir/readback.json" > /dev/null \
  || fail failed 'Deployment readback did not confirm the selected Worker version at 100%; inspect before retrying.'

# Only safe HTTP reads are retried to allow for edge propagation. A successful
# control-plane write alone does not establish the serving code's identity.
for attempt in 1 2 3 4 5 6; do
  if curl -fsS --connect-timeout 5 --max-time 10 -H 'Cache-Control: no-cache' \
    "$worker_url/health" > "$work_dir/health.json" 2> "$work_dir/curl-error" && \
    jq -e '.status == "ok"' "$work_dir/health.json" > /dev/null 2>&1 && \
    curl -fsS --connect-timeout 5 --max-time 10 -H 'Cache-Control: no-cache' \
    "$worker_url/api/build-info" > "$work_dir/build-info.json" 2> "$work_dir/curl-error"; then
    observed_sha=$(jq -r '.commitSha | select(type == "string" and test("^[0-9a-f]{40}$"))' \
      "$work_dir/build-info.json" 2>/dev/null) || observed_sha=unavailable
    if [ "$observed_sha" = "$TARGET_COMMIT" ]; then
      worker_status=success
      worker_detail='Worker version deployed at 100%; health and exact release SHA verified.'
      break
    fi
    [ -n "$observed_sha" ] || observed_sha=unavailable
  fi
  if [ "$attempt" -lt 6 ]; then sleep 5; fi
done
if [ "$worker_status" != success ]; then
  fail failed 'Worker health/build-info did not verify the target SHA after bounded propagation checks; inspect the serving version. No mutation was retried.'
fi
