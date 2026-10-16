#!/usr/bin/env bash
# Supported App-only rollback entry point, invoked after the production queue.
# Same env/dependencies as resolve-app-rollback-target.sh. No target overrides,
# bypass, automatic retry of mutations, API/Runner changes, or asset publication.
# Exits nonzero on validation, mutation, or exact 100% deployment readback failure.
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
umask 077
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT
bash "$script_dir/resolve-app-rollback-target.sh" > "$work_dir/target.json"
cat "$work_dir/target.json"
printf 'Authorization: Bearer %s\n' "$CLOUDFLARE_API_TOKEN" > "$work_dir/cf-header"
cf_base="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/okou-app-production"
jq '{strategy:"percentage", versions:[{version_id:.version_id, percentage:100}],
  annotations:{"workers/message":("Guarded App rollback to artifact " + .artifact_sha)}}' \
  "$work_dir/target.json" > "$work_dir/request.json"
curl -fsS --connect-timeout 10 --max-time 30 -H "@$work_dir/cf-header" \
  -H 'Content-Type: application/json' --request POST --data-binary "@$work_dir/request.json" \
  "$cf_base/deployments" > "$work_dir/response.json"
deployment_id=$(jq -er 'select(.success == true) | .result.id' "$work_dir/response.json") \
  || { echo 'Cloudflare did not return a successful App deployment; inspect before retrying' >&2; exit 1; }
[[ "$deployment_id" =~ ^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$ ]] || { echo 'Invalid Cloudflare deployment response' >&2; exit 1; }
curl -fsS --connect-timeout 10 --max-time 30 -H "@$work_dir/cf-header" \
  "$cf_base/deployments" > "$work_dir/readback.json"
jq -e --arg deployment "$deployment_id" --arg version "$APP_VERSION_ID" \
  '.success == true and .result.deployments[0].id == $deployment and
   .result.deployments[0].versions == [{version_id:$version, percentage:100}]' \
  "$work_dir/readback.json" >/dev/null || { echo 'App rollback readback did not confirm the selected version at 100%' >&2; exit 1; }
echo "App rollback verified: deployment $deployment_id, version $APP_VERSION_ID at 100%."
