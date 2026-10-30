#!/usr/bin/env bash
set -euo pipefail
set +x

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ACTION="${REPO_ROOT}/.github/actions/web-api-env/action.yml"
BROWSER_EXTENSION_ID="11111111-1111-4111-8111-111111111111"
EXPECTED_BUILD_COMMIT_SHA="$(git -C "$REPO_ROOT" rev-parse --verify HEAD)"
TEMP_DIRS=()
REGISTRY_PID=""
GITHUB_APP_VAR_SUFFIXES=(
  SLUG
  ID
  CLIENT_ID
)
GITHUB_APP_SECRET_SUFFIXES=(
  CLIENT_SECRET
  WEBHOOK_SECRET
  PRIVATE_KEY
)

cleanup() {
  if [[ -n "$REGISTRY_PID" ]]; then
    kill "$REGISTRY_PID" 2>/dev/null || true
    wait "$REGISTRY_PID" 2>/dev/null || true
  fi
  if [[ "${#TEMP_DIRS[@]}" -gt 0 ]]; then
    rm -rf "${TEMP_DIRS[@]}"
  fi
}
trap cleanup EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

assert_contains() {
  local output="$1"
  local expected="$2"
  if [[ "$output" != *"$expected"* ]]; then
    fail "expected output to contain: ${expected}"
  fi
}

assert_not_contains() {
  local output="$1"
  local unexpected="$2"
  if [[ "$output" == *"$unexpected"* ]]; then
    fail "did not expect output to contain: ${unexpected}"
  fi
}

assert_env_value() {
  local env_file="$1"
  local key="$2"
  local expected="$3"
  local value
  value="$(awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; found = 1 } END { if (!found) exit 1 }' "$env_file")" ||
    fail "expected ${key} in ${env_file}"
  if [[ "$value" != "$expected" ]]; then
    fail "unexpected value for ${key}"
  fi
}

assert_env_absent_value() {
  local env_file="$1"
  local unexpected="$2"
  if grep -Fq "$unexpected" "$env_file"; then
    fail "rendered env contained a forbidden fixture value"
  fi
}

assert_env_key_absent() {
  local env_file="$1"
  local key="$2"
  if awk -F= -v key="$key" '$1 == key { found = 1 } END { exit !found }' "$env_file"; then
    fail "did not expect ${key} in ${env_file}"
  fi
}

assert_env_key_count() {
  local env_file="$1"
  local key="$2"
  local expected="$3"
  local count
  count="$(awk -F= -v key="$key" '$1 == key { count++ } END { print count + 0 }' "$env_file")"
  if [[ "$count" != "$expected" ]]; then
    fail "expected ${key} exactly ${expected} time(s) in ${env_file}"
  fi
}

assert_preview_job_ref_absent() {
  local env_file="$1"
  assert_env_key_absent "$env_file" OKOU_PREVIEW_JOB_REF
}

assert_debug_canonical() {
  local env_file="$1"
  assert_env_key_count "$env_file" OKOU_DEBUG 1
  assert_env_value "$env_file" OKOU_DEBUG "*"
}

assert_debug_absent() {
  local env_file="$1"
  assert_env_key_absent "$env_file" OKOU_DEBUG
}

assert_google_llm_config() {
  local env_file="$1"
  local account="$2"
  assert_env_value "$env_file" GCP_LLM_PROJECT_ID "vm0-ai-488909"
  assert_env_value "$env_file" GCP_LLM_WORKLOAD_IDENTITY_PROVIDER "projects/662642595011/locations/global/workloadIdentityPools/vercel-vm0-api/providers/vercel"
  assert_env_value "$env_file" GCP_LLM_SERVICE_ACCOUNT_EMAIL "$account"
  assert_env_key_count "$env_file" GCP_LLM_SERVICE_ACCOUNT_EMAIL 1
}

assert_api_backend_url_canonical() {
  local env_file="$1"
  local expected="$2"
  assert_env_key_count "$env_file" OKOU_API_BACKEND_URL 1
  assert_env_value "$env_file" OKOU_API_BACKEND_URL "$expected"
}

assert_api_backend_url_absent() {
  local env_file="$1"
  assert_env_key_absent "$env_file" OKOU_API_BACKEND_URL
}

assert_machine_secret_canonical() {
  local env_file="$1"
  local expected="$2"
  assert_env_key_count "$env_file" OKOU_MACHINE_SECRET_KEY 1
  assert_env_value "$env_file" OKOU_MACHINE_SECRET_KEY "$expected"
}

assert_machine_secret_absent() {
  local env_file="$1"
  assert_env_key_absent "$env_file" OKOU_MACHINE_SECRET_KEY
}

assert_machine_secret_values_absent_from_output() {
  local output="$1"
  shift
  local value
  for value in "$@"; do
    assert_not_contains "$output" "$value"
  done
}

assert_web_url_canonical() {
  local env_file="$1"
  local expected="$2"
  assert_env_key_count "$env_file" OKOU_WEB_URL 1
  assert_env_value "$env_file" OKOU_WEB_URL "$expected"
}

assert_web_url_absent() {
  local env_file="$1"
  assert_env_key_absent "$env_file" OKOU_WEB_URL
}

assert_no_fixture_secret_values() {
  local output="$1"
  local unexpected
  for unexpected in \
    "github-" \
    "doppler-"; do
    if [[ "$output" == *"$unexpected"* ]]; then
      fail "render output exposed a fixture secret value"
    fi
  done
}

assert_github_app_mapping_values() {
  local env_file="$1"
  local repo_vars_json="$2"
  local repo_secrets_json="$3"
  local suffix
  local expected
  for suffix in "${GITHUB_APP_VAR_SUFFIXES[@]}"; do
    expected="$(jq -r --arg key "OKOU_GITHUB_APP_${suffix}" '.[$key] // ""' <<< "$repo_vars_json")"
    assert_env_value "$env_file" "GITHUB_APP_${suffix}" "$expected"
  done
  for suffix in "${GITHUB_APP_SECRET_SUFFIXES[@]}"; do
    expected="$(jq -r --arg key "OKOU_GITHUB_APP_${suffix}" '.[$key] // ""' <<< "$repo_secrets_json")"
    assert_env_value "$env_file" "GITHUB_APP_${suffix}" "$expected"
  done
}

assert_github_app_empty_outputs() {
  local env_file="$1"
  local suffix
  for suffix in "${GITHUB_APP_VAR_SUFFIXES[@]}" "${GITHUB_APP_SECRET_SUFFIXES[@]}"; do
    assert_env_value "$env_file" "GITHUB_APP_${suffix}" ""
  done
}

assert_github_app_source_keys_absent() {
  local env_file="$1"
  local suffix
  for suffix in "${GITHUB_APP_VAR_SUFFIXES[@]}" "${GITHUB_APP_SECRET_SUFFIXES[@]}"; do
    assert_env_key_absent "$env_file" "OKOU_GITHUB_APP_${suffix}"
  done
}

extract_action_script() {
  awk '
    /^      run: \|$/ {
      in_run = 1
      next
    }
    in_run && /^        / {
      sub(/^        /, "")
      print
      next
    }
    in_run && /^$/ {
      print
      next
    }
    in_run {
      exit
    }
  ' "$ACTION"
}

oauth_client_config_prefixes() {
  awk '
    /^        oauth_client_config_prefixes=\($/ {
      in_list = 1
      next
    }
    in_list && /^        \)$/ {
      exit
    }
    in_list {
      sub(/^        /, "")
      gsub(/[[:space:]]/, "")
      if ($0 != "") {
        print
      }
    }
  ' "$ACTION"
}

oauth_client_config_keys() {
  local prefix
  while IFS= read -r prefix; do
    printf '%s_OAUTH_CLIENT_ID\n' "$prefix"
    printf '%s_OAUTH_CLIENT_SECRET\n' "$prefix"
  done <<< "$(oauth_client_config_prefixes)"
}

build_doppler_secrets_json() {
  local omit_key="${1:-}"
  local json="{}"
  local key
  while IFS= read -r key; do
    if [[ "$key" == "$omit_key" ]]; then
      continue
    fi
    json="$(jq -c --arg key "$key" --arg value "doppler-${key}" '. + {($key): $value}' <<< "$json")"
  done <<< "$(oauth_client_config_keys)"
  json="$(
    jq -c '
      . + {
        LINK_OAUTH_CLIENT_ID: "doppler-link-client-id",
        LINK_OAUTH_CLIENT_SECRET: "doppler-link-client-secret",
        LINK_STRIPE_PUBLISHABLE_KEY: "pk_live_link_fixture",
        STRIPE_WEBHOOK_SECRET: "doppler-stripe-billing-webhook-secret",
        STRIPE_AUTOMATION_WEBHOOK_SECRET: "doppler-stripe-automation-webhook-secret"
      }
    ' <<< "$json"
  )"
  printf '%s' "$json"
}

run_action() {
  local doppler_secrets_json="$1"
  local test_dir="$2"
  local input_app="${3:-api}"
  local input_environment="${4:-preview}"
  local branded_config="${5:-canonical}"
  local github_app_vars_json="${6:-}"
  local github_app_secrets_json="${7:-}"
  local input_job_ref="${8-pr-123}"
  local input_api_backend_url="${9-https://pr-123-api-backend.okou.test}"
  local machine_secret_repo_secrets_json="${10:-}"
  local extra_repo_vars_json="${11:-}"
  local input_extension_release_created="${12:-true}"
  local input_extension_id="${13-$BROWSER_EXTENSION_ID}"
  local action_script="${test_dir}/web-api-env-action.sh"
  local github_output="${test_dir}/github-output"
  local repo_vars_json
  local repo_secrets_json

  if [[ -z "$github_app_vars_json" ]]; then
    github_app_vars_json="{}"
  fi
  if [[ -z "$github_app_secrets_json" ]]; then
    github_app_secrets_json="{}"
  fi
  if [[ -z "$extra_repo_vars_json" ]]; then
    extra_repo_vars_json="{}"
  fi

  repo_vars_json='{"GH_OAUTH_CLIENT_ID":"github-gh-client-id","SLACK_OAUTH_CLIENT_ID":"github-slack-client-id","GOOGLE_ADS_DEVELOPER_TOKEN":"github-google-ads-var","FINICITY_PARTNER_ID":"github-finicity-partner-id","LINK_STRIPE_PUBLISHABLE_KEY":"pk_live_github_link_fixture","POSTHOG_KEY":"github-posthog-key","POSTHOG_HOST":"https://posthog.github.test","ATOM_URL":"https://atom.github.test","STRIPE_OAUTH_CLIENT_ID":"ca_test_connect_client","STRIPE_CONCURRENCY_PORTAL_CONFIGURATION_ID":"bpc_test_concurrency","MICROSOFT_TEAMS_BOT_APP_ID":"github-teams-bot-app-id","MICROSOFT_TEAMS_APP_TENANT_ID":"github-teams-app-tenant-id","OKOU_PRICE_PRO":"price_test_pro","OKOU_PRICE_TEAM":"price_test_team","OKOU_PRICE_USAGE_PACK_PLAN_PRO":"price_test_usage_pack_plan_pro","OKOU_PRICE_USAGE_PACK_PLAN_TEAM":"price_test_usage_pack_plan_team","OKOU_PRICE_USAGE_PACK_20":"price_test_usage_pack_20","OKOU_PRICE_USAGE_PACK_50":"price_test_usage_pack_50","OKOU_PRICE_USAGE_PACK_100":"price_test_usage_pack_100","OKOU_PRICE_USAGE_PACK_200":"price_test_usage_pack_200","ATOM_GRANT_PRICE":"price_test_atom_grant","OKOU_PRICE_CUSTOM_CREDITS":"price_test_custom_credits","OKOU_PRICE_CUSTOM_CREDIT_UNIT":"price_test_custom_credit_unit","OKOU_PRICE_CONCURRENCY":"price_test_concurrency","GMAIL_PUBSUB_TOPIC_NAME":"projects/github/topics/gmail","GMAIL_PUBSUB_PUSH_AUDIENCE":"https://api.github.test/api/webhooks/gmail","GMAIL_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL":"gmail-push@github.test","GOOGLE_WORKSPACE_EVENTS_PUBSUB_TOPIC_NAME":"projects/github/topics/google-workspace-events","GOOGLE_WORKSPACE_EVENTS_PUBSUB_PUSH_AUDIENCE":"https://api.github.test/api/webhooks/google-workspace-events","GOOGLE_WORKSPACE_EVENTS_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL":"workspace-events-push@github.test"}'
  repo_vars_json="$(jq -c '. + {OKOU_PUBLIC_ARTIFACTS_BASE_URL: "https://cdn.okou.test", OKOU_PUBLIC_HOST_DOMAIN: "okou.app", OKOU_HOST_SCHEME: "https", OKOU_ONE_TIME_CAMPAIGN: "test-campaign"}' <<< "$repo_vars_json")"
  repo_secrets_json='{"R2_PRIVATE_ARTIFACTS_ACCESS_KEY_ID":"private-prod-key","R2_PRIVATE_ARTIFACTS_SECRET_ACCESS_KEY":"private-prod-secret","R2_PRIVATE_ARTIFACTS_ACCESS_KEY_ID_DEV":"private-dev-key","R2_PRIVATE_ARTIFACTS_SECRET_ACCESS_KEY_DEV":"private-dev-secret","GH_OAUTH_CLIENT_SECRET":"github-gh-client-secret","SLACK_OAUTH_CLIENT_SECRET":"github-slack-client-secret","GOOGLE_ADS_DEVELOPER_TOKEN":"github-google-ads-secret","OKOU_DATA_ROUTER_URL":"https://data.okou.ai/mcp","OKOU_DATA_TOKEN":"github-data-router-token","OKOU_BROWSER_USE_API_KEY":"github-browser-use-api-key","STEAM_WEB_API_KEY":"github-steam-web-api-key","LINK_OAUTH_CLIENT_ID":"github-link-client-id","LINK_OAUTH_CLIENT_SECRET":"github-link-client-secret","FINICITY_APP_KEY":"github-finicity-app-key","FINICITY_APP_SECRET":"github-finicity-app-secret","OKOU_MACHINE_SECRET_KEY":"github-atom-machine-secret","MICROSOFT_TEAMS_BOT_APP_PASSWORD":"github-teams-bot-app-password","VERCEL_AUTOMATION_BYPASS_SECRET":"github-vercel-bypass-secret","STRIPE_WEBHOOK_SECRET":"github-stripe-billing-webhook-secret","STRIPE_AUTOMATION_WEBHOOK_SECRET":"github-stripe-automation-webhook-secret"}'
  repo_vars_json="$(jq -c '. + {APNS_KEY_ID: "TESTKEY001", APNS_TEAM_ID: "TESTTEAM01"}' <<< "$repo_vars_json")"
  repo_secrets_json="$(jq -c '. + {
    APNS_PRIVATE_KEY_BASE64: "github-apns-test-key",
    PREVIEW_KMS_KEY_ID: "github-preview-kms-key",
    PREVIEW_KMS_ACCESS_KEY_ID: "github-preview-kms-access-key",
    PREVIEW_KMS_SECRET_ACCESS_KEY: "github-preview-kms-secret",
    SECRETS_KMS_KEY_ID: "github-production-kms-key",
    AWS_ACCESS_KEY_ID: "github-production-kms-access-key",
    AWS_SECRET_ACCESS_KEY: "github-production-kms-secret"
  }' <<< "$repo_secrets_json")"
  if [[ "$branded_config" == "empty" ]]; then
    repo_vars_json="$(jq -c 'with_entries(select(.key | startswith("OKOU_") | not))' <<< "$repo_vars_json")"
    repo_secrets_json="$(jq -c 'with_entries(select(.key | startswith("OKOU_") | not))' <<< "$repo_secrets_json")"
  fi
  # Repository defaults; the caller supplies GitHub Environment overrides in
  # the same resolved vars object used by the deployment workflow.
  repo_vars_json="$(jq -c '. + {GCP_LLM_PROJECT_ID: "vm0-ai-488909", GCP_LLM_WORKLOAD_IDENTITY_PROVIDER: "projects/662642595011/locations/global/workloadIdentityPools/vercel-vm0-api/providers/vercel", GCP_LLM_SERVICE_ACCOUNT_EMAIL: "llm-dev@vm0-ai-488909.iam.gserviceaccount.com"}' <<< "$repo_vars_json")"
  repo_vars_json="$(jq -c --argjson github_app_vars "$github_app_vars_json" '. + $github_app_vars' <<< "$repo_vars_json")"
  repo_vars_json="$(jq -c --argjson extra_repo_vars "$extra_repo_vars_json" '. + $extra_repo_vars' <<< "$repo_vars_json")"
  repo_secrets_json="$(jq -c --argjson github_app_secrets "$github_app_secrets_json" '. + $github_app_secrets' <<< "$repo_secrets_json")"
  if [[ -n "$machine_secret_repo_secrets_json" ]]; then
    repo_secrets_json="$(
      jq -c \
        --argjson machine_secret_sources "$machine_secret_repo_secrets_json" \
        'del(.OKOU_MACHINE_SECRET_KEY) + $machine_secret_sources' \
        <<< "$repo_secrets_json"
    )"
  fi

  extract_action_script > "$action_script"

  env \
    RUNNER_TEMP="$test_dir" \
    GITHUB_OUTPUT="$github_output" \
    GITHUB_SHA="test-sha" \
    INPUT_APP="$input_app" \
    INPUT_ENVIRONMENT="$input_environment" \
    INPUT_DATABASE_URL="postgres://preview-db" \
    INPUT_JOB_REF="$input_job_ref" \
    INPUT_WEB_URL="https://pr-123-www.okou.test" \
    INPUT_APP_URL="https://pr-123-app.okou.test" \
    INPUT_API_BACKEND_URL="$input_api_backend_url" \
    INPUT_BROWSER_EXTENSION_RELEASE_CREATED="$input_extension_release_created" \
    INPUT_BROWSER_EXTENSION_ID="$input_extension_id" \
    REPO_VARS_JSON="$repo_vars_json" \
    REPO_SECRETS_JSON="$repo_secrets_json" \
    DOPPLER_SECRETS_JSON="$doppler_secrets_json" \
    bash "$action_script"
}

run_github_app_action() {
  local test_dir="$1"
  local repo_vars_json="$2"
  local repo_secrets_json="$3"
  run_action \
    "$(build_doppler_secrets_json)" \
    "$test_dir" \
    api \
    preview \
    canonical \
    "$repo_vars_json" \
    "$repo_secrets_json"
}

run_machine_secret_action() {
  local test_dir="$1"
  local input_app="$2"
  local input_environment="$3"
  local repo_secrets_json="$4"
  run_action \
    "$(build_doppler_secrets_json)" \
    "$test_dir" \
    "$input_app" \
    "$input_environment" \
    canonical \
    "" \
    "" \
    pr-123 \
    "https://pr-123-api-backend.okou.test" \
    "$repo_secrets_json"
}

run_switch_action() {
  local test_dir="$1"
  local input_app="$2"
  local input_environment="$3"
  local extra_repo_vars_json="$4"
  run_action \
    "$(build_doppler_secrets_json)" \
    "$test_dir" \
    "$input_app" \
    "$input_environment" \
    canonical \
    "" \
    "" \
    pr-123 \
    "https://pr-123-api-backend.okou.test" \
    "" \
    "$extra_repo_vars_json"
}

assert_machine_secret_canonical_case() {
  local input_environment="$1"
  local repo_secrets_json="$2"
  local expected="$3"
  local test_dir
  local output
  local env_file
  test_dir="$(mktemp -d)"
  TEMP_DIRS+=("$test_dir")
  output="$(run_machine_secret_action "$test_dir" api "$input_environment" "$repo_secrets_json" 2>&1)"
  env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${test_dir}/github-output")"
  assert_contains "$output" "Rendered"
  assert_machine_secret_values_absent_from_output "$output" "$expected"
  assert_machine_secret_canonical "$env_file" "$expected"
}

if grep -En 'add_(var|secret) [A-Z0-9_]+_OAUTH_CLIENT_(ID|SECRET)' "$ACTION"; then
  fail "OAuth client id/secret entries must come from Doppler, not GitHub vars or secrets"
fi

if ! oauth_client_config_prefixes | grep -qx SLACK; then
  fail "expected Slack OAuth client config to come from Doppler"
fi

github_app_canonical_vars_json='{"OKOU_GITHUB_APP_SLUG":" github-canonical-slug ","OKOU_GITHUB_APP_ID":"github-canonical-id","OKOU_GITHUB_APP_CLIENT_ID":"github-canonical-client-id"}'
github_app_canonical_secrets_json='{"OKOU_GITHUB_APP_CLIENT_SECRET":"github-canonical-client-secret","OKOU_GITHUB_APP_WEBHOOK_SECRET":"github-canonical-webhook-secret","OKOU_GITHUB_APP_PRIVATE_KEY":"github-canonical-private-key"}'
github_app_canonical_dir="$(mktemp -d)"
TEMP_DIRS+=("$github_app_canonical_dir")
github_app_canonical_output="$(run_github_app_action "$github_app_canonical_dir" "$github_app_canonical_vars_json" "$github_app_canonical_secrets_json" 2>&1)"
github_app_canonical_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${github_app_canonical_dir}/github-output")"
assert_contains "$github_app_canonical_output" "Rendered"
assert_no_fixture_secret_values "$github_app_canonical_output"
assert_github_app_mapping_values "$github_app_canonical_env_file" "$github_app_canonical_vars_json" "$github_app_canonical_secrets_json"
assert_github_app_source_keys_absent "$github_app_canonical_env_file"

github_app_empty_dir="$(mktemp -d)"
TEMP_DIRS+=("$github_app_empty_dir")
github_app_empty_output="$(run_github_app_action "$github_app_empty_dir" '{}' '{}' 2>&1)"
github_app_empty_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${github_app_empty_dir}/github-output")"
assert_contains "$github_app_empty_output" "Rendered"
assert_no_fixture_secret_values "$github_app_empty_output"
assert_github_app_empty_outputs "$github_app_empty_env_file"
assert_github_app_source_keys_absent "$github_app_empty_env_file"

assert_machine_secret_canonical_case \
  preview \
  '{"OKOU_MACHINE_SECRET_KEY":" preview-canonical-machine-secret=bytes "}' \
  " preview-canonical-machine-secret=bytes "
assert_machine_secret_canonical_case \
  production \
  '{"OKOU_MACHINE_SECRET_KEY":" production-canonical-machine-secret=bytes "}' \
  " production-canonical-machine-secret=bytes "

machine_secret_absent_dir="$(mktemp -d)"
TEMP_DIRS+=("$machine_secret_absent_dir")
machine_secret_absent_output="$(run_machine_secret_action "$machine_secret_absent_dir" api preview '{}' 2>&1)"
machine_secret_absent_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${machine_secret_absent_dir}/github-output")"
assert_contains "$machine_secret_absent_output" "Rendered"
assert_machine_secret_absent "$machine_secret_absent_env_file"

machine_secret_web_dir="$(mktemp -d)"
TEMP_DIRS+=("$machine_secret_web_dir")
machine_secret_web_output="$(
  run_machine_secret_action \
    "$machine_secret_web_dir" \
    web \
    preview \
    '{"OKOU_MACHINE_SECRET_KEY":" web-isolated-machine-secret "}' \
    2>&1
)"
machine_secret_web_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${machine_secret_web_dir}/github-output")"
assert_contains "$machine_secret_web_output" "Rendered"
assert_machine_secret_values_absent_from_output "$machine_secret_web_output" " web-isolated-machine-secret "
assert_machine_secret_absent "$machine_secret_web_env_file"

api_backend_url_explicit_dir="$(mktemp -d)"
TEMP_DIRS+=("$api_backend_url_explicit_dir")
api_backend_url_explicit_output="$(
  run_action \
    "$(build_doppler_secrets_json)" \
    "$api_backend_url_explicit_dir" \
    api \
    production \
    canonical \
    "" \
    "" \
    pr-123 \
    "https://explicit-api.example.test" \
    2>&1
)"
api_backend_url_explicit_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${api_backend_url_explicit_dir}/github-output")"
assert_contains "$api_backend_url_explicit_output" "Rendered"
assert_api_backend_url_canonical "$api_backend_url_explicit_env_file" "https://explicit-api.example.test"
assert_env_value "$api_backend_url_explicit_env_file" FEISHU_CALLBACK_BASE_URL "https://explicit-api.example.test"
assert_env_value "$api_backend_url_explicit_env_file" FINICITY_WEBHOOK_BASE_URL "https://explicit-api.example.test"

for api_backend_url_environment in preview production; do
  api_backend_url_absent_dir="$(mktemp -d)"
  TEMP_DIRS+=("$api_backend_url_absent_dir")
  status=0
  api_backend_url_absent_output="$(
    run_action \
      "$(build_doppler_secrets_json)" \
      "$api_backend_url_absent_dir" \
      api \
      "$api_backend_url_environment" \
      canonical \
      "" \
      "" \
      pr-123 \
      "" \
      2>&1
  )" || status=$?
  if [[ "$status" -eq 0 ]]; then
    fail "expected missing API backend URL to fail for ${api_backend_url_environment}"
  fi
  assert_contains "$api_backend_url_absent_output" "::error::api-backend-url is required for API deployments"
  if [[ -e "${api_backend_url_absent_dir}/web-api-api-${api_backend_url_environment}.env" ]]; then
    fail "missing API backend URL must fail before creating an environment file"
  fi
done

web_backend_url_absent_dir="$(mktemp -d)"
TEMP_DIRS+=("$web_backend_url_absent_dir")
web_backend_url_absent_output="$(
  run_action \
    "$(build_doppler_secrets_json)" \
    "$web_backend_url_absent_dir" \
    web \
    production \
    canonical \
    "" \
    "" \
    pr-123 \
    "" \
    2>&1
)"
web_backend_url_absent_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${web_backend_url_absent_dir}/github-output")"
assert_contains "$web_backend_url_absent_output" "Rendered"
assert_api_backend_url_absent "$web_backend_url_absent_env_file"
assert_env_key_absent "$web_backend_url_absent_env_file" MCP_RESOURCE_URL

# Exercise environment-specific audiences and issuers through the real renderer.
# A shared resource variable must never override a deployment's own API URL.
for mcp_case in \
  'api|preview|https://pr-123-api.okou.test|https://clerk-dev.example.test|https://pr-123-api.okou.test/mcp' \
  'api|production|https://api.okou.test/|https://clerk.example.test|https://api.okou.test/mcp' \
  'web|production|https://api.okou.test|https://clerk.example.test|'; do
  IFS='|' read -r mcp_app mcp_environment mcp_api_url mcp_issuer mcp_resource <<< "$mcp_case"
  mcp_dir="$(mktemp -d)"
  TEMP_DIRS+=("$mcp_dir")
  mcp_vars="$(jq -nc --arg issuer "$mcp_issuer" \
    '{MCP_OAUTH_ISSUER: $issuer, MCP_RESOURCE_URL: "https://wrong-resource.example.test/mcp"}')"
  mcp_output="$(run_action "$(build_doppler_secrets_json)" "$mcp_dir" \
    "$mcp_app" "$mcp_environment" \
    canonical "" "" pr-123 "$mcp_api_url" "" "$mcp_vars" 2>&1)"
  mcp_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${mcp_dir}/github-output")"
  assert_contains "$mcp_output" "Rendered"
  if [[ "$mcp_app" == "api" ]]; then
    assert_env_value "$mcp_env_file" MCP_RESOURCE_URL "$mcp_resource"
    assert_env_value "$mcp_env_file" MCP_OAUTH_ISSUER "$mcp_issuer"
  else
    assert_env_key_absent "$mcp_env_file" MCP_RESOURCE_URL
    assert_env_key_absent "$mcp_env_file" MCP_OAUTH_ISSUER
  fi
done

# The disabled wallet pilot must not make Link credentials required for deployment,
# and populated GitHub fixture secrets must not become a fallback source.
missing_wallet_dir="$(mktemp -d)"
TEMP_DIRS+=("$missing_wallet_dir")
missing_wallet_output="$(run_action "$(build_doppler_secrets_json | jq -c 'del(.LINK_OAUTH_CLIENT_ID, .LINK_OAUTH_CLIENT_SECRET, .LINK_STRIPE_PUBLISHABLE_KEY)')" "$missing_wallet_dir" 2>&1)"
missing_wallet_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${missing_wallet_dir}/github-output")"
assert_contains "$missing_wallet_output" "Rendered"
assert_env_value "$missing_wallet_env_file" LINK_OAUTH_CLIENT_ID ""
assert_env_value "$missing_wallet_env_file" LINK_OAUTH_CLIENT_SECRET ""

success_dir="$(mktemp -d)"
TEMP_DIRS+=("$success_dir")
success_output="$(run_action "$(build_doppler_secrets_json)" "$success_dir" 2>&1)"
success_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${success_dir}/github-output")"
assert_contains "$success_output" "Rendered"
assert_no_fixture_secret_values "$success_output"
assert_machine_secret_values_absent_from_output "$success_output" "github-atom-machine-secret"
assert_env_value "$success_env_file" SECRETS_KMS_KEY_ID "github-preview-kms-key"
assert_env_value "$success_env_file" AWS_ACCESS_KEY_ID "github-preview-kms-access-key"
assert_env_value "$success_env_file" AWS_SECRET_ACCESS_KEY "github-preview-kms-secret"
assert_env_absent_value "$success_env_file" "github-production-kms"
assert_debug_canonical "$success_env_file"
assert_env_value "$success_env_file" R2_PRIVATE_ARTIFACTS_BUCKET_NAME "user-artifact-private-dev"
assert_env_value "$success_env_file" R2_PRIVATE_ARTIFACTS_ACCESS_KEY_ID "private-dev-key"
assert_env_value "$success_env_file" R2_PRIVATE_ARTIFACTS_SECRET_ACCESS_KEY "private-dev-secret"
assert_env_value "$success_env_file" GH_OAUTH_CLIENT_ID "doppler-GH_OAUTH_CLIENT_ID"
assert_env_value "$success_env_file" GH_OAUTH_CLIENT_SECRET "doppler-GH_OAUTH_CLIENT_SECRET"
assert_env_value "$success_env_file" SLACK_OAUTH_CLIENT_ID "doppler-SLACK_OAUTH_CLIENT_ID"
assert_env_value "$success_env_file" SLACK_OAUTH_CLIENT_SECRET "doppler-SLACK_OAUTH_CLIENT_SECRET"
assert_env_value "$success_env_file" ZOOM_OAUTH_CLIENT_ID "doppler-ZOOM_OAUTH_CLIENT_ID"
assert_env_value "$success_env_file" ZOOM_OAUTH_CLIENT_SECRET "doppler-ZOOM_OAUTH_CLIENT_SECRET"
assert_env_value "$success_env_file" MAILCHIMP_OAUTH_CLIENT_ID "doppler-MAILCHIMP_OAUTH_CLIENT_ID"
assert_env_value "$success_env_file" MAILCHIMP_OAUTH_CLIENT_SECRET "doppler-MAILCHIMP_OAUTH_CLIENT_SECRET"
assert_env_value "$success_env_file" CAL_COM_OAUTH_CLIENT_ID "doppler-CAL_COM_OAUTH_CLIENT_ID"
assert_env_value "$success_env_file" CAL_COM_OAUTH_CLIENT_SECRET "doppler-CAL_COM_OAUTH_CLIENT_SECRET"
assert_env_value "$success_env_file" COPPER_OAUTH_CLIENT_ID "doppler-COPPER_OAUTH_CLIENT_ID"
assert_env_value "$success_env_file" COPPER_OAUTH_CLIENT_SECRET "doppler-COPPER_OAUTH_CLIENT_SECRET"
assert_env_key_absent "$success_env_file" CALCOM_OAUTH_CLIENT_ID
assert_env_key_absent "$success_env_file" CALCOM_OAUTH_CLIENT_SECRET
assert_env_value "$success_env_file" BOX_OAUTH_CLIENT_ID "doppler-BOX_OAUTH_CLIENT_ID"
assert_env_value "$success_env_file" BOX_OAUTH_CLIENT_SECRET "doppler-BOX_OAUTH_CLIENT_SECRET"
assert_env_value "$success_env_file" QUICKBOOKS_OAUTH_CLIENT_ID "doppler-QUICKBOOKS_OAUTH_CLIENT_ID"
assert_env_value "$success_env_file" QUICKBOOKS_OAUTH_CLIENT_SECRET "doppler-QUICKBOOKS_OAUTH_CLIENT_SECRET"
assert_env_value "$success_env_file" RAMP_OAUTH_CLIENT_ID "doppler-RAMP_OAUTH_CLIENT_ID"
assert_env_value "$success_env_file" RAMP_OAUTH_CLIENT_SECRET "doppler-RAMP_OAUTH_CLIENT_SECRET"
assert_env_value "$success_env_file" TIKTOK_ADS_OAUTH_CLIENT_ID "doppler-TIKTOK_ADS_OAUTH_CLIENT_ID"
assert_env_value "$success_env_file" TIKTOK_ADS_OAUTH_CLIENT_SECRET "doppler-TIKTOK_ADS_OAUTH_CLIENT_SECRET"
assert_env_value "$success_env_file" MICROSOFT_TEAMS_BOT_APP_ID "github-teams-bot-app-id"
assert_env_value "$success_env_file" MICROSOFT_TEAMS_BOT_APP_PASSWORD "github-teams-bot-app-password"
assert_env_value "$success_env_file" MICROSOFT_TEAMS_APP_TENANT_ID "github-teams-app-tenant-id"
assert_env_value "$success_env_file" GOOGLE_ADS_DEVELOPER_TOKEN "github-google-ads-secret"
assert_env_value "$success_env_file" OKOU_BROWSER_USE_API_KEY "github-browser-use-api-key"
assert_env_value "$success_env_file" OKOU_BROWSER_USE_EXTENSION_ID "$BROWSER_EXTENSION_ID"
assert_env_value "$success_env_file" STEAM_WEB_API_KEY "github-steam-web-api-key"
assert_env_value "$success_env_file" LINK_OAUTH_CLIENT_ID "doppler-link-client-id"
assert_env_value "$success_env_file" LINK_OAUTH_CLIENT_SECRET "doppler-link-client-secret"
assert_env_absent_value "$success_env_file" "github-link-client-id"
assert_env_absent_value "$success_env_file" "github-link-client-secret"
assert_not_contains "$success_output" "doppler-link-client-secret"
assert_env_value "$success_env_file" LINK_STRIPE_PUBLISHABLE_KEY "pk_live_link_fixture"
assert_env_value "$success_env_file" FINICITY_APP_KEY "github-finicity-app-key"
assert_env_value "$success_env_file" FINICITY_APP_SECRET "github-finicity-app-secret"
assert_env_value "$success_env_file" FINICITY_PARTNER_ID "github-finicity-partner-id"
assert_env_value "$success_env_file" ATOM_URL "https://tunnel-yuma-atom-api.vm7.ai"
assert_machine_secret_canonical "$success_env_file" "github-atom-machine-secret"
assert_env_value "$success_env_file" VERCEL_AUTOMATION_BYPASS_SECRET "github-vercel-bypass-secret"
assert_env_key_count "$success_env_file" OKOU_PREVIEW_JOB_REF 1
assert_env_value "$success_env_file" OKOU_PREVIEW_JOB_REF "pr-123"
assert_api_backend_url_canonical "$success_env_file" "https://pr-123-api-backend.okou.test"
assert_env_value "$success_env_file" MCP_RESOURCE_URL "https://pr-123-api-backend.okou.test/mcp"
assert_env_value "$success_env_file" MCP_OAUTH_ISSUER ""
assert_google_llm_config "$success_env_file" "llm-dev@vm0-ai-488909.iam.gserviceaccount.com"
assert_env_value "$success_env_file" FEISHU_CALLBACK_BASE_URL "https://pr-123-api-backend.okou.test"
assert_env_value "$success_env_file" FINICITY_WEBHOOK_BASE_URL "https://pr-123-api-backend.okou.test"
assert_web_url_canonical "$success_env_file" "https://pr-123-www.okou.test"
assert_env_value "$success_env_file" GIT_COMMIT_SHA "$EXPECTED_BUILD_COMMIT_SHA"
assert_env_absent_value "$success_env_file" "ONBOARDING_URL="
assert_env_value "$success_env_file" OKOU_PRICE_PRO "price_test_pro"
assert_env_value "$success_env_file" OKOU_PRICE_TEAM "price_test_team"
assert_env_value "$success_env_file" OKOU_PRICE_USAGE_PACK_PLAN_PRO "price_test_usage_pack_plan_pro"
assert_env_value "$success_env_file" OKOU_PRICE_USAGE_PACK_PLAN_TEAM "price_test_usage_pack_plan_team"
assert_env_value "$success_env_file" OKOU_PRICE_USAGE_PACK_20 "price_test_usage_pack_20"
assert_env_value "$success_env_file" OKOU_PRICE_USAGE_PACK_50 "price_test_usage_pack_50"
assert_env_value "$success_env_file" OKOU_PRICE_USAGE_PACK_100 "price_test_usage_pack_100"
assert_env_value "$success_env_file" OKOU_PRICE_USAGE_PACK_200 "price_test_usage_pack_200"
assert_env_value "$success_env_file" ATOM_GRANT_PRICE "price_test_atom_grant"
assert_env_value "$success_env_file" OKOU_PRICE_CUSTOM_CREDITS "price_test_custom_credits"
assert_env_value "$success_env_file" OKOU_PRICE_CUSTOM_CREDIT_UNIT "price_test_custom_credit_unit"
assert_env_value "$success_env_file" OKOU_PRICE_CONCURRENCY "price_test_concurrency"
assert_env_value "$success_env_file" OKOU_PUBLIC_ARTIFACTS_BASE_URL "https://cdn.okou.test"
assert_env_value "$success_env_file" PUBLIC_ARTIFACT_SHARES_BASE_URL "https://files.sites.vm7.io"
assert_env_value "$success_env_file" OKOU_PUBLIC_HOST_DOMAIN "okou.app"
assert_env_value "$success_env_file" OKOU_HOST_SCHEME "https"
assert_env_value "$success_env_file" OKOU_ONE_TIME_CAMPAIGN "test-campaign"
assert_env_value "$success_env_file" GMAIL_PUBSUB_TOPIC_NAME "projects/github/topics/gmail"
assert_env_value "$success_env_file" GMAIL_PUBSUB_PUSH_AUDIENCE "https://api.github.test/api/webhooks/gmail"
assert_env_value "$success_env_file" GMAIL_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL "gmail-push@github.test"
assert_env_value "$success_env_file" GOOGLE_WORKSPACE_EVENTS_PUBSUB_TOPIC_NAME "projects/github/topics/google-workspace-events"
assert_env_value "$success_env_file" GOOGLE_WORKSPACE_EVENTS_PUBSUB_PUSH_AUDIENCE "https://api.github.test/api/webhooks/google-workspace-events"
assert_env_value "$success_env_file" GOOGLE_WORKSPACE_EVENTS_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL "workspace-events-push@github.test"
assert_env_value "$success_env_file" STRIPE_OAUTH_CLIENT_ID "doppler-STRIPE_OAUTH_CLIENT_ID"
assert_env_value "$success_env_file" STRIPE_OAUTH_CLIENT_SECRET "doppler-STRIPE_OAUTH_CLIENT_SECRET"
assert_env_value "$success_env_file" STRIPE_CONCURRENCY_PORTAL_CONFIGURATION_ID "bpc_test_concurrency"
assert_env_absent_value "$success_env_file" "github-gh-client-id"
assert_env_absent_value "$success_env_file" "github-gh-client-secret"
assert_env_absent_value "$success_env_file" "github-slack-client-id"
assert_env_absent_value "$success_env_file" "github-slack-client-secret"
assert_env_absent_value "$success_env_file" "github-posthog-key"
assert_env_absent_value "$success_env_file" "github-cloudflare-browser-rendering-token"
assert_env_absent_value "$success_env_file" "github-artifact-preview-waf-secret"

preview_web_dir="$(mktemp -d)"
TEMP_DIRS+=("$preview_web_dir")
preview_web_output="$(run_action "$(build_doppler_secrets_json)" "$preview_web_dir" web preview 2>&1)"
preview_web_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${preview_web_dir}/github-output")"
assert_contains "$preview_web_output" "Rendered"
assert_no_fixture_secret_values "$preview_web_output"
assert_machine_secret_values_absent_from_output "$preview_web_output" "github-atom-machine-secret"
assert_preview_job_ref_absent "$preview_web_env_file"
assert_debug_canonical "$preview_web_env_file"
assert_api_backend_url_canonical "$preview_web_env_file" "https://pr-123-api-backend.okou.test"
assert_env_key_absent "$preview_web_env_file" OKOU_MACHINE_SECRET_KEY
assert_web_url_absent "$preview_web_env_file"
assert_env_key_absent "$preview_web_env_file" GCP_LLM_PROJECT_ID
assert_env_key_absent "$preview_web_env_file" GCP_LLM_WORKLOAD_IDENTITY_PROVIDER
assert_env_key_absent "$preview_web_env_file" GCP_LLM_SERVICE_ACCOUNT_EMAIL

empty_job_ref_dir="$(mktemp -d)"
TEMP_DIRS+=("$empty_job_ref_dir")
empty_job_ref_output="$(run_action "$(build_doppler_secrets_json)" "$empty_job_ref_dir" api preview canonical "" "" "" 2>&1)"
empty_job_ref_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${empty_job_ref_dir}/github-output")"
assert_contains "$empty_job_ref_output" "Rendered"
assert_preview_job_ref_absent "$empty_job_ref_env_file"
assert_debug_canonical "$empty_job_ref_env_file"
assert_api_backend_url_canonical "$empty_job_ref_env_file" "https://pr-123-api-backend.okou.test"
assert_machine_secret_canonical "$empty_job_ref_env_file" "github-atom-machine-secret"

empty_dir="$(mktemp -d)"
TEMP_DIRS+=("$empty_dir")
empty_output="$(run_action "$(build_doppler_secrets_json)" "$empty_dir" api preview empty 2>&1)"
empty_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${empty_dir}/github-output")"
assert_contains "$empty_output" "Rendered"
assert_no_fixture_secret_values "$empty_output"
assert_debug_canonical "$empty_env_file"
assert_api_backend_url_canonical "$empty_env_file" "https://pr-123-api-backend.okou.test"
assert_machine_secret_absent "$empty_env_file"
assert_env_value "$empty_env_file" OKOU_PUBLIC_ARTIFACTS_BASE_URL ""
assert_env_value "$empty_env_file" OKOU_PUBLIC_HOST_DOMAIN ""
assert_env_value "$empty_env_file" OKOU_PRICE_PRO ""
assert_env_value "$empty_env_file" OKOU_ONE_TIME_CAMPAIGN ""

production_web_dir="$(mktemp -d)"
TEMP_DIRS+=("$production_web_dir")
production_web_output="$(run_action "$(build_doppler_secrets_json)" "$production_web_dir" web production 2>&1)"
production_web_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${production_web_dir}/github-output")"
assert_contains "$production_web_output" "Rendered"
assert_no_fixture_secret_values "$production_web_output"
assert_machine_secret_values_absent_from_output "$production_web_output" "github-atom-machine-secret"
assert_env_value "$production_web_env_file" OKOU_HOST_SCHEME "https"
assert_debug_absent "$production_web_env_file"
assert_api_backend_url_canonical "$production_web_env_file" "https://pr-123-api-backend.okou.test"
assert_web_url_absent "$production_web_env_file"
assert_env_key_absent "$production_web_env_file" GCP_LLM_PROJECT_ID
assert_env_key_absent "$production_web_env_file" GCP_LLM_WORKLOAD_IDENTITY_PROVIDER
assert_env_key_absent "$production_web_env_file" GCP_LLM_SERVICE_ACCOUNT_EMAIL
assert_env_value "$production_web_env_file" POSTHOG_KEY "github-posthog-key"
assert_env_value "$production_web_env_file" POSTHOG_HOST "https://posthog.github.test"
assert_env_value "$production_web_env_file" GIT_COMMIT_SHA "$EXPECTED_BUILD_COMMIT_SHA"
assert_env_absent_value "$production_web_env_file" "ATOM_URL="
assert_env_key_absent "$production_web_env_file" OKOU_MACHINE_SECRET_KEY
assert_env_absent_value "$production_web_env_file" "OKOU_BROWSER_USE_API_KEY="
assert_env_key_absent "$production_web_env_file" OKOU_BROWSER_USE_EXTENSION_ID
assert_env_absent_value "$production_web_env_file" "github-cloudflare-browser-rendering-token"
assert_env_absent_value "$production_web_env_file" "github-artifact-preview-waf-secret"

production_api_dir="$(mktemp -d)"
TEMP_DIRS+=("$production_api_dir")
production_api_output="$(run_action "$(build_doppler_secrets_json)" "$production_api_dir" api production canonical '{"GCP_LLM_SERVICE_ACCOUNT_EMAIL":"llm-prod@vm0-ai-488909.iam.gserviceaccount.com"}' '{"PREVIEW_KMS_KEY_ID":null,"PREVIEW_KMS_ACCESS_KEY_ID":null,"PREVIEW_KMS_SECRET_ACCESS_KEY":null}' 2>&1)"
production_api_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${production_api_dir}/github-output")"
assert_contains "$production_api_output" "Rendered"
assert_no_fixture_secret_values "$production_api_output"
assert_machine_secret_values_absent_from_output "$production_api_output" "github-atom-machine-secret"
assert_env_value "$production_api_env_file" APNS_PRIVATE_KEY_BASE64 "github-apns-test-key"
assert_env_value "$production_api_env_file" APNS_KEY_ID "TESTKEY001"
assert_env_value "$production_api_env_file" APNS_TEAM_ID "TESTTEAM01"
assert_env_key_absent "$success_env_file" APNS_PRIVATE_KEY_BASE64
assert_env_key_absent "$success_env_file" APNS_KEY_ID
assert_env_key_absent "$success_env_file" APNS_TEAM_ID
assert_env_key_absent "$preview_web_env_file" APNS_PRIVATE_KEY_BASE64
assert_env_key_absent "$preview_web_env_file" APNS_KEY_ID
assert_env_key_absent "$preview_web_env_file" APNS_TEAM_ID
assert_env_key_absent "$production_web_env_file" APNS_PRIVATE_KEY_BASE64
assert_env_key_absent "$production_web_env_file" APNS_KEY_ID
assert_env_key_absent "$production_web_env_file" APNS_TEAM_ID
assert_env_value "$production_api_env_file" SECRETS_KMS_KEY_ID "github-production-kms-key"
assert_env_value "$production_api_env_file" AWS_ACCESS_KEY_ID "github-production-kms-access-key"
assert_env_value "$production_api_env_file" AWS_SECRET_ACCESS_KEY "github-production-kms-secret"
assert_env_absent_value "$production_api_env_file" "github-preview-kms"
assert_env_value "$production_api_env_file" OKOU_HOST_SCHEME "https"
assert_debug_absent "$production_api_env_file"
assert_google_llm_config "$production_api_env_file" "llm-prod@vm0-ai-488909.iam.gserviceaccount.com"
assert_env_value "$production_api_env_file" MAILCHIMP_OAUTH_CLIENT_ID "doppler-MAILCHIMP_OAUTH_CLIENT_ID"
assert_env_value "$production_api_env_file" MAILCHIMP_OAUTH_CLIENT_SECRET "doppler-MAILCHIMP_OAUTH_CLIENT_SECRET"
assert_env_value "$production_api_env_file" CAL_COM_OAUTH_CLIENT_ID "doppler-CAL_COM_OAUTH_CLIENT_ID"
assert_env_value "$production_api_env_file" CAL_COM_OAUTH_CLIENT_SECRET "doppler-CAL_COM_OAUTH_CLIENT_SECRET"
assert_env_value "$production_api_env_file" COPPER_OAUTH_CLIENT_ID "doppler-COPPER_OAUTH_CLIENT_ID"
assert_env_value "$production_api_env_file" COPPER_OAUTH_CLIENT_SECRET "doppler-COPPER_OAUTH_CLIENT_SECRET"
assert_env_value "$production_api_env_file" R2_PRIVATE_ARTIFACTS_BUCKET_NAME "user-artifact-private-prod"
assert_env_value "$production_api_env_file" R2_PRIVATE_ARTIFACTS_ACCESS_KEY_ID "private-prod-key"
assert_env_value "$production_api_env_file" R2_PRIVATE_ARTIFACTS_SECRET_ACCESS_KEY "private-prod-secret"
assert_web_url_canonical "$production_api_env_file" "https://pr-123-www.okou.test"
assert_api_backend_url_canonical "$production_api_env_file" "https://pr-123-api-backend.okou.test"
assert_env_value "$production_api_env_file" FEISHU_CALLBACK_BASE_URL "https://pr-123-api-backend.okou.test"
assert_env_value "$production_api_env_file" FINICITY_WEBHOOK_BASE_URL "https://pr-123-api-backend.okou.test"
assert_env_value "$production_api_env_file" ATOM_URL "https://atom.github.test"
assert_machine_secret_canonical "$production_api_env_file" "github-atom-machine-secret"
assert_env_value "$production_api_env_file" MICROSOFT_TEAMS_BOT_APP_ID "github-teams-bot-app-id"
assert_env_value "$production_api_env_file" MICROSOFT_TEAMS_BOT_APP_PASSWORD "github-teams-bot-app-password"
assert_env_value "$production_api_env_file" MICROSOFT_TEAMS_APP_TENANT_ID "github-teams-app-tenant-id"
assert_env_value "$production_api_env_file" OKOU_BROWSER_USE_API_KEY "github-browser-use-api-key"
assert_env_value "$production_api_env_file" OKOU_BROWSER_USE_EXTENSION_ID "$BROWSER_EXTENSION_ID"
assert_env_absent_value "$production_api_env_file" "ONBOARDING_URL="
assert_env_value "$production_api_env_file" STRIPE_WEBHOOK_SECRET "github-stripe-billing-webhook-secret"
assert_env_value "$production_api_env_file" STRIPE_AUTOMATION_WEBHOOK_SECRET "github-stripe-automation-webhook-secret"
assert_env_absent_value "$production_api_env_file" "doppler-stripe-billing-webhook-secret"
assert_env_absent_value "$production_api_env_file" "doppler-stripe-automation-webhook-secret"
assert_preview_job_ref_absent "$production_api_env_file"

for kms_secret in PREVIEW_KMS_KEY_ID PREVIEW_KMS_ACCESS_KEY_ID PREVIEW_KMS_SECRET_ACCESS_KEY; do
  missing_kms_dir="$(mktemp -d)"
  TEMP_DIRS+=("$missing_kms_dir")
  missing_kms_secret="$(jq -cn --arg key "$kms_secret" '{($key): null}')"
  status=0
  missing_kms_output="$(run_action "$(build_doppler_secrets_json)" "$missing_kms_dir" api preview canonical "" "$missing_kms_secret" 2>&1)" || status=$?
  if [[ "$status" -eq 0 ]]; then
    fail "preview must reject incomplete KMS credentials instead of using production credentials"
  fi
  assert_contains "$missing_kms_output" "${kms_secret} is missing from GitHub secrets"
  assert_no_fixture_secret_values "$missing_kms_output"
done

wechat_vars_json='{"WECHAT_GATEWAY_URL":"https://wechat-gateway.example.test"}'
wechat_secrets_json='{"WECHAT_GATEWAY_SECRET":"wechat-hmac-fixture","WECHAT_GATEWAY_CONTROL_SECRET":"wechat-control-fixture"}'
for wechat_environment in preview production; do
  for wechat_app in api web; do
    wechat_dir="$(mktemp -d)"
    TEMP_DIRS+=("$wechat_dir")
    wechat_output="$(
      run_action \
        "$(build_doppler_secrets_json)" \
        "$wechat_dir" \
        "$wechat_app" \
        "$wechat_environment" \
        canonical \
        "$wechat_vars_json" \
        "$wechat_secrets_json" \
        2>&1
    )"
    wechat_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${wechat_dir}/github-output")"
    assert_not_contains "$wechat_output" "wechat-hmac-fixture"
    assert_not_contains "$wechat_output" "wechat-control-fixture"
    if [[ "$wechat_app" == "api" ]]; then
      assert_env_value "$wechat_env_file" WECHAT_GATEWAY_URL "https://wechat-gateway.example.test"
      assert_env_value "$wechat_env_file" WECHAT_GATEWAY_SECRET "wechat-hmac-fixture"
      assert_env_value "$wechat_env_file" WECHAT_GATEWAY_CONTROL_SECRET "wechat-control-fixture"
    else
      assert_env_key_absent "$wechat_env_file" WECHAT_GATEWAY_URL
      assert_env_key_absent "$wechat_env_file" WECHAT_GATEWAY_SECRET
      assert_env_key_absent "$wechat_env_file" WECHAT_GATEWAY_CONTROL_SECRET
    fi
  done
done

link_approval_vars_json='{"LINK_APPROVAL_WORKER_URL":"https://link-approval-gateway.example.test"}'
link_approval_secrets_json='{"LINK_APPROVAL_WORKER_SECRET":"link_approval-hmac-fixture","LINK_APPROVAL_CONTROL_SECRET":"link_approval-control-fixture"}'
for link_approval_environment in preview production; do
  for link_approval_app in api web; do
    link_approval_dir="$(mktemp -d)"
    TEMP_DIRS+=("$link_approval_dir")
    link_approval_output="$(
      run_action \
        "$(build_doppler_secrets_json)" \
        "$link_approval_dir" \
        "$link_approval_app" \
        "$link_approval_environment" \
        canonical \
        "$link_approval_vars_json" \
        "$link_approval_secrets_json" \
        2>&1
    )"
    link_approval_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${link_approval_dir}/github-output")"
    assert_not_contains "$link_approval_output" "link_approval-hmac-fixture"
    assert_not_contains "$link_approval_output" "link_approval-control-fixture"
    if [[ "$link_approval_app" == "api" ]]; then
      assert_env_value "$link_approval_env_file" LINK_APPROVAL_WORKER_URL "https://link-approval-gateway.example.test"
      assert_env_value "$link_approval_env_file" LINK_APPROVAL_WORKER_SECRET "link_approval-hmac-fixture"
      assert_env_value "$link_approval_env_file" LINK_APPROVAL_CONTROL_SECRET "link_approval-control-fixture"
    else
      assert_env_key_absent "$link_approval_env_file" LINK_APPROVAL_WORKER_URL
      assert_env_key_absent "$link_approval_env_file" LINK_APPROVAL_WORKER_SECRET
      assert_env_key_absent "$link_approval_env_file" LINK_APPROVAL_CONTROL_SECRET
    fi
  done
done

discord_vars_json='{"DISCORD_APPLICATION_ID":"123456789012345678","DISCORD_PUBLIC_KEY":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","DISCORD_OAUTH_CLIENT_ID":"github-discord-legacy-client-id","DISCORD_GATEWAY_ENABLED":"true"}'
discord_secrets_json='{"DISCORD_BOT_TOKEN":"github-discord-bot-token","DISCORD_GATEWAY_SECRET":"github-discord-hmac-secret-1234567890","DISCORD_OAUTH_CLIENT_SECRET":"github-discord-legacy-oauth-secret","DISCORD_GATEWAY_CONTROL_SECRET":"github-discord-control-secret"}'
discord_doppler_json="$(
  jq -c '. + {
    DISCORD_OAUTH_CLIENT_ID: "doppler-discord-client-id",
    DISCORD_OAUTH_CLIENT_SECRET: "doppler-discord-oauth-secret",
    DISCORD_BOT_TOKEN: "doppler-discord-wrong-bot-token",
    DISCORD_GATEWAY_SECRET: "doppler-discord-wrong-hmac-secret"
  }' <<< "$(build_doppler_secrets_json)"
)"
discord_keys=(
  DISCORD_APPLICATION_ID
  DISCORD_PUBLIC_KEY
  DISCORD_BOT_TOKEN
  DISCORD_GATEWAY_SECRET
  DISCORD_OAUTH_CLIENT_SECRET
)
for discord_environment in preview production; do
  for discord_app in api web; do
    discord_dir="$(mktemp -d)"
    TEMP_DIRS+=("$discord_dir")
    discord_output="$(
      run_action \
        "$discord_doppler_json" \
        "$discord_dir" \
        "$discord_app" \
        "$discord_environment" \
        canonical \
        "$discord_vars_json" \
        "$discord_secrets_json" \
        2>&1
    )"
    discord_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${discord_dir}/github-output")"
    assert_contains "$discord_output" "Rendered"
    assert_no_fixture_secret_values "$discord_output"
    assert_env_key_absent "$discord_env_file" DISCORD_OAUTH_CLIENT_ID
    assert_env_key_absent "$discord_env_file" DISCORD_GATEWAY_ENABLED
    assert_env_key_absent "$discord_env_file" DISCORD_GATEWAY_CONTROL_SECRET
    if [[ "$discord_app" == "api" ]]; then
      assert_env_value "$discord_env_file" DISCORD_APPLICATION_ID "123456789012345678"
      assert_env_value "$discord_env_file" DISCORD_PUBLIC_KEY "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      assert_env_value "$discord_env_file" DISCORD_BOT_TOKEN "github-discord-bot-token"
      assert_env_value "$discord_env_file" DISCORD_GATEWAY_SECRET "github-discord-hmac-secret-1234567890"
      assert_env_value "$discord_env_file" DISCORD_OAUTH_CLIENT_SECRET "doppler-discord-oauth-secret"
      for discord_key in "${discord_keys[@]}"; do
        assert_env_key_count "$discord_env_file" "$discord_key" 1
      done
      assert_env_absent_value "$discord_env_file" "github-discord-legacy"
      assert_env_absent_value "$discord_env_file" "doppler-discord-wrong"
    else
      for discord_key in "${discord_keys[@]}"; do
        assert_env_key_absent "$discord_env_file" "$discord_key"
      done
      assert_env_absent_value "$discord_env_file" "github-discord"
      assert_env_absent_value "$discord_env_file" "doppler-discord"
    fi
  done

  unconfigured_discord_dir="$(mktemp -d)"
  TEMP_DIRS+=("$unconfigured_discord_dir")
  unconfigured_discord_output="$(
    run_action \
      "$(build_doppler_secrets_json)" \
      "$unconfigured_discord_dir" \
      api \
      "$discord_environment" \
      canonical \
      '{"DISCORD_OAUTH_CLIENT_ID":"github-discord-legacy-client-id"}' \
      '{"DISCORD_OAUTH_CLIENT_SECRET":"github-discord-legacy-oauth-secret"}' \
      2>&1
  )"
  unconfigured_discord_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${unconfigured_discord_dir}/github-output")"
  assert_contains "$unconfigured_discord_output" "Rendered"
  assert_no_fixture_secret_values "$unconfigured_discord_output"
  for discord_key in "${discord_keys[@]}"; do
    assert_env_key_count "$unconfigured_discord_env_file" "$discord_key" 1
    assert_env_value "$unconfigured_discord_env_file" "$discord_key" ""
  done
  assert_env_key_absent "$unconfigured_discord_env_file" DISCORD_OAUTH_CLIENT_ID
  assert_env_key_absent "$unconfigured_discord_env_file" DISCORD_GATEWAY_ENABLED
  assert_env_key_absent "$unconfigured_discord_env_file" DISCORD_GATEWAY_CONTROL_SECRET
  assert_env_absent_value "$unconfigured_discord_env_file" "github-discord-legacy"
done

missing_dir="$(mktemp -d)"
TEMP_DIRS+=("$missing_dir")
status=0
missing_output="$(run_action "$(build_doppler_secrets_json GH_OAUTH_CLIENT_SECRET)" "$missing_dir" 2>&1)" || status=$?
if [[ "$status" -eq 0 ]]; then
  fail "expected missing Doppler OAuth client config to fail"
fi
assert_contains "$missing_output" "::error::GH_OAUTH_CLIENT_SECRET is missing from Doppler OAuth config"

missing_stripe_dir="$(mktemp -d)"
TEMP_DIRS+=("$missing_stripe_dir")
status=0
missing_stripe_output="$(run_action "$(build_doppler_secrets_json STRIPE_OAUTH_CLIENT_ID)" "$missing_stripe_dir" 2>&1)" || status=$?
if [[ "$status" -eq 0 ]]; then
  fail "expected missing Stripe Doppler OAuth client id to fail"
fi
assert_contains "$missing_stripe_output" "::error::STRIPE_OAUTH_CLIENT_ID is missing from Doppler OAuth config"

missing_stripe_secret_dir="$(mktemp -d)"
TEMP_DIRS+=("$missing_stripe_secret_dir")
status=0
missing_stripe_secret_output="$(run_action "$(build_doppler_secrets_json STRIPE_OAUTH_CLIENT_SECRET)" "$missing_stripe_secret_dir" 2>&1)" || status=$?
if [[ "$status" -eq 0 ]]; then
  fail "expected missing Stripe Doppler OAuth client secret to fail"
fi
assert_contains "$missing_stripe_secret_output" "::error::STRIPE_OAUTH_CLIENT_SECRET is missing from Doppler OAuth config"

for oauth_key in MAILCHIMP_OAUTH_CLIENT_ID MAILCHIMP_OAUTH_CLIENT_SECRET CAL_COM_OAUTH_CLIENT_ID CAL_COM_OAUTH_CLIENT_SECRET COPPER_OAUTH_CLIENT_ID COPPER_OAUTH_CLIENT_SECRET; do
  missing_oauth_dir="$(mktemp -d)"
  TEMP_DIRS+=("$missing_oauth_dir")
  status=0
  missing_oauth_output="$(run_action "$(build_doppler_secrets_json "$oauth_key")" "$missing_oauth_dir" 2>&1)" || status=$?
  if [[ "$status" -eq 0 ]]; then
    fail "expected missing Doppler OAuth config to fail"
  fi
  assert_contains "$missing_oauth_output" "::error::${oauth_key} is missing from Doppler OAuth config"
  assert_no_fixture_secret_values "$missing_oauth_output"
done

assert_env_value "$production_api_env_file" OKOU_DATA_ROUTER_URL "https://data.okou.ai/mcp"
assert_env_value "$production_api_env_file" OKOU_DATA_TOKEN "github-data-router-token"

assert_env_value "$success_env_file" WHATSAPP_ALLOWED_COUNTRY_PREFIXES ""
assert_env_value "$production_api_env_file" WHATSAPP_ALLOWED_COUNTRY_PREFIXES ""
assert_env_key_absent "$production_web_env_file" WHATSAPP_ALLOWED_COUNTRY_PREFIXES
for whatsapp_environment in preview production; do
  for whatsapp_app in api web; do
    whatsapp_dir="$(mktemp -d)"
    TEMP_DIRS+=("$whatsapp_dir")
    run_switch_action \
      "$whatsapp_dir" \
      "$whatsapp_app" \
      "$whatsapp_environment" \
      '{"WHATSAPP_ALLOWED_COUNTRY_PREFIXES":"+1,+49"}' \
      > "${whatsapp_dir}/output"
    whatsapp_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${whatsapp_dir}/github-output")"
    if [[ "$whatsapp_app" == "api" ]]; then
      assert_env_value "$whatsapp_env_file" WHATSAPP_ALLOWED_COUNTRY_PREFIXES "+1,+49"
    else
      assert_env_key_absent "$whatsapp_env_file" WHATSAPP_ALLOWED_COUNTRY_PREFIXES
    fi
  done
done

# Exercise the no-release branch through the actual environment producer too.
coproc EXTENSION_REGISTRY {
  exec node --input-type=module <<'JS'
import { createServer } from "node:http";
let lookups = 0;
const server = createServer((request, response) => {
  if (request.headers["x-browser-use-api-key"] !== "github-browser-use-api-key") {
    response.writeHead(403).end();
    return;
  }
  const items = lookups++ === 0 ? [{
      id: "22222222-2222-4222-8222-222222222222",
      name: "Okou Browser",
      version: "0.10.0",
      createdAt: "2026-10-30T00:00:00Z",
  }] : [];
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({
    items,
    totalItems: items.length,
    pageNumber: 1,
    pageSize: 100,
  }));
});
server.listen(0, "127.0.0.1", () => {
  console.log(`http://127.0.0.1:${server.address().port}`);
});
JS
}
REGISTRY_PID="$EXTENSION_REGISTRY_PID"
IFS= read -r registry_origin <&"${EXTENSION_REGISTRY[0]}"
lookup_dir="$(mktemp -d)"
TEMP_DIRS+=("$lookup_dir")
BROWSER_USE_API_URL="$registry_origin" run_action \
  "$(build_doppler_secrets_json)" "$lookup_dir" api preview canonical \
  "{}" "{}" pr-123 https://pr-123-api-backend.okou.test "" "" false "" \
  > "${lookup_dir}/output"
lookup_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${lookup_dir}/github-output")"
assert_env_value "$lookup_env_file" OKOU_BROWSER_USE_EXTENSION_ID "22222222-2222-4222-8222-222222222222"
missing_lookup_dir="$(mktemp -d)"
TEMP_DIRS+=("$missing_lookup_dir")
status=0
missing_lookup_output="$(BROWSER_USE_API_URL="$registry_origin" run_action \
  "$(build_doppler_secrets_json)" "$missing_lookup_dir" api production canonical \
  "{}" "{}" "" https://api.okou.test "" "" false "" 2>&1)" || status=$?
if [[ "$status" -eq 0 || -s "${missing_lookup_dir}/github-output" ]]; then
  fail "expected an unavailable extension to stop environment publication"
fi
assert_contains "$missing_lookup_output" "No uploaded Okou Browser extension was found"
kill "$REGISTRY_PID"
wait "$REGISTRY_PID" 2>/dev/null || true
REGISTRY_PID=""

echo "web-api-env-action-test: ok"
