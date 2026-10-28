#!/usr/bin/env bash
# Offline process-boundary tests: curl/Cloudflare/Worker and sleep are fixtures.
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$script_dir/../release/rollback-api-worker-production.sh"
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT
mkdir "$work_dir/bin"
export PATH="$work_dir/bin:$PATH"
export TARGET_COMMIT=4444444444444444444444444444444444444444
export CLOUDFLARE_ACCOUNT_ID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
export CLOUDFLARE_API_TOKEN=private-fixture-token
export FIXTURE_DIR="$work_dir"

cat > "$work_dir/bin/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
method=GET
body=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --request) method=$2; shift 2 ;;
    --data-binary) body=${2#@}; shift 2 ;;
    -H)
      if [[ "$2" == @* ]]; then
        header=${2#@}
        [ "$(stat -c %a "$header")" = 600 ]
        grep -Fqx "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$header"
        printf '%s\n' "$header" > "$FIXTURE_DIR/header-path"
      fi
      shift 2 ;;
    --connect-timeout|--max-time) shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
printf '%s %s\n' "$method" "$url" >> "$FIXTURE_DIR/requests"
base="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/okou-api-production"
case "$method $url" in
  "GET $base/versions?deployable=true")
    if [ "$SCENARIO" = inventory-failure ]; then exit 22; fi
    if [ "$SCENARIO" = malformed-inventory ]; then
      printf '%s\n' '{"success":true,"result":{"items":null}}'
      exit 0
    fi
    jq -n --arg sha "$TARGET_COMMIT" --arg scenario "$SCENARIO" '
      {success:true, result:{items:
        ([range(1; 15) | {id:"11111111-1111-1111-1111-111111111111", number:.,
          annotations:{"workers/tag":"5555555555555555555555555555555555555555"}}] +
        (if $scenario == "missing-version" then
          [{id:"22222222-2222-2222-2222-222222222222", number:16, annotations:{}}]
         else
          [{id:"33333333-3333-3333-3333-333333333333", number:17, annotations:{"workers/tag":$sha}}] +
          (if $scenario == "ambiguous-version" then
            [{id:"22222222-2222-2222-2222-222222222222", number:16, annotations:{"workers/tag":$sha}}]
           else [] end)
         end))}}
    ' ;;
  "POST $base/deployments")
    jq -e --arg sha "$TARGET_COMMIT" '
      .strategy == "percentage" and
      .versions == [{version_id:"33333333-3333-3333-3333-333333333333", percentage:100}] and
      .annotations["workers/message"] == ("Paired API rollback to " + $sha)
    ' "$body" > /dev/null
    cp "$body" "$FIXTURE_DIR/deployed.json"
    if [ "$SCENARIO" = lost-write-response ]; then
      echo "$CLOUDFLARE_API_TOKEN" >&2
      exit 52
    fi
    if [ "$SCENARIO" = rejected-write ]; then
      printf '%s\n' '{"success":false,"errors":[{"code":10021,"message":"private-fixture-token"}]}'
    else
      printf '%s\n' '{"success":true,"result":{"id":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}}'
    fi ;;
  "GET $base/deployments")
    jq -n --arg scenario "$SCENARIO" '
      {success:true,result:{deployments:[{id:"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        versions:(if $scenario == "readback-mismatch" then
          [{version_id:"33333333-3333-3333-3333-333333333333", percentage:50},
           {version_id:"11111111-1111-1111-1111-111111111111", percentage:50}]
         else [{version_id:"33333333-3333-3333-3333-333333333333", percentage:100}] end)}]}}
    ' ;;
  'GET https://okou-api-production.vm0.workers.dev/health')
    if [ "$SCENARIO" = unhealthy ]; then
      printf '%s\n' '{"status":"unhealthy"}'
    else
      printf '%s\n' '{"status":"ok"}'
    fi ;;
  'GET https://okou-api-production.vm0.workers.dev/api/build-info')
    reads=$(grep -c '/api/build-info$' "$FIXTURE_DIR/requests")
    if [ "$SCENARIO" = stale-sha ] || { [ "$SCENARIO" = propagation ] && [ "$reads" -eq 1 ]; }; then
      printf '%s\n' '{"commitSha":"5555555555555555555555555555555555555555"}'
    else
      jq -n --arg sha "$TARGET_COMMIT" '{commitSha:$sha}'
    fi ;;
  *) echo "Unhandled fixture request: $method $url" >&2; exit 1 ;;
esac
SH
cat > "$work_dir/bin/sleep" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FIXTURE_DIR/sleeps"
SH
chmod +x "$work_dir/bin/"*

run_case() {
  export SCENARIO=$1
  local expected_status=$2
  export GITHUB_OUTPUT="$work_dir/outputs"
  export GITHUB_STEP_SUMMARY="$work_dir/summary"
  rm -f "$work_dir/"{requests,outputs,summary,deployed.json,sleeps,header-path}
  local status=0
  bash "$script" > "$work_dir/log" 2>&1 || status=$?
  if [ "$expected_status" = success ]; then
    [ "$status" -eq 0 ]
  else
    [ "$status" -ne 0 ]
    grep -Fq '::warning::API Worker rollback:' "$work_dir/log"
    grep -Fq 'Vercel API rollback is not blocked' "$work_dir/log"
  fi
  grep -Fqx "status=$expected_status" "$GITHUB_OUTPUT"
  grep -Fq "Paired API Worker rollback: $expected_status" "$GITHUB_STEP_SUMMARY"
  if grep -Fq "$CLOUDFLARE_API_TOKEN" "$work_dir/log" "$GITHUB_OUTPUT" "$GITHUB_STEP_SUMMARY"; then
    echo 'Fixture credential leaked' >&2
    exit 1
  fi
  local header
  header=$(< "$work_dir/header-path")
  [ ! -e "$header" ]
}

# Full deployable inventory, exact SHA (not a nearby release), unique match,
# 100% deployment readback and edge propagation before success is reported.
run_case propagation success
grep -Fqx "observed-sha=$TARGET_COMMIT" "$GITHUB_OUTPUT"
grep -Fqx 'version-id=33333333-3333-3333-3333-333333333333' "$GITHUB_OUTPUT"
[ "$(grep -c '^POST ' "$work_dir/requests")" -eq 1 ]
[ "$(grep -c '/api/build-info$' "$work_dir/requests")" -eq 2 ]
[ "$(wc -l < "$work_dir/sleeps")" -eq 1 ]

# Failed release upload, legacy untagged release or expired history: no mutation.
run_case missing-version missing-version
[ ! -e "$work_dir/deployed.json" ]
grep -Fq 'Worker left unchanged' "$GITHUB_OUTPUT"
run_case ambiguous-version ambiguous-version
[ ! -e "$work_dir/deployed.json" ]
for scenario in inventory-failure malformed-inventory; do
  run_case "$scenario" failed
  [ ! -e "$work_dir/deployed.json" ]
done

# A lost response may follow a completed write: never blindly replay it.
run_case lost-write-response uncertain
[ "$(grep -c '^POST ' "$work_dir/requests")" -eq 1 ]
grep -Fq 'write may have applied' "$GITHUB_OUTPUT"
for scenario in rejected-write readback-mismatch; do
  run_case "$scenario" failed
  [ "$(grep -c '^POST ' "$work_dir/requests")" -eq 1 ]
  [ -e "$work_dir/deployed.json" ]
done

# Control-plane success is insufficient: healthy wrong SHA and unhealthy target
# both fail after bounded GET-only propagation checks, without another write.
for scenario in stale-sha unhealthy; do
  run_case "$scenario" failed
  [ "$(grep -c '^POST ' "$work_dir/requests")" -eq 1 ]
  [ "$(grep -c '/health$' "$work_dir/requests")" -eq 6 ]
  [ "$(wc -l < "$work_dir/sleeps")" -eq 5 ]
done

echo 'API Worker paired rollback process tests passed'
# Workflow policy and notification consumer tests use only Node built-ins.
node --test "$script_dir/../api-worker-workflow.test.cjs"
