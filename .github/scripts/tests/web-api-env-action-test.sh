#!/usr/bin/env bash
set -euo pipefail
set +x

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ACTION="${REPO_ROOT}/.github/actions/web-api-env/action.yml"
EXPECTED_BUILD_COMMIT_SHA="$(git -C "$REPO_ROOT" rev-parse --verify HEAD)"
TEMP_DIRS=()
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
  local input_cli_pkg_url="${5-https://static.okou.io/okou-cli/test-sha/package.tgz}"
  local branded_config="${6:-canonical}"
  local github_app_vars_json="${7:-}"
  local github_app_secrets_json="${8:-}"
  local input_job_ref="${9-pr-123}"
  local input_api_backend_url="${10-https://pr-123-api-backend.okou.test}"
  local machine_secret_repo_secrets_json="${11:-}"
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

  repo_vars_json='{"GH_OAUTH_CLIENT_ID":"github-gh-client-id","SLACK_OAUTH_CLIENT_ID":"github-slack-client-id","GOOGLE_ADS_DEVELOPER_TOKEN":"github-google-ads-var","FINICITY_PARTNER_ID":"github-finicity-partner-id","POSTHOG_KEY":"github-posthog-key","POSTHOG_HOST":"https://posthog.github.test","ATOM_URL":"https://atom.github.test","STRIPE_OAUTH_CLIENT_ID":"ca_test_connect_client","STRIPE_CONCURRENCY_PORTAL_CONFIGURATION_ID":"bpc_test_concurrency","MICROSOFT_TEAMS_BOT_APP_ID":"github-teams-bot-app-id","MICROSOFT_TEAMS_APP_TENANT_ID":"github-teams-app-tenant-id","OKOU_PRICE_PRO":"price_test_pro","OKOU_PRICE_TEAM":"price_test_team","OKOU_PRICE_USAGE_PACK_PLAN_PRO":"price_test_usage_pack_plan_pro","OKOU_PRICE_USAGE_PACK_PLAN_TEAM":"price_test_usage_pack_plan_team","OKOU_PRICE_USAGE_PACK_20":"price_test_usage_pack_20","OKOU_PRICE_USAGE_PACK_50":"price_test_usage_pack_50","OKOU_PRICE_USAGE_PACK_100":"price_test_usage_pack_100","OKOU_PRICE_USAGE_PACK_200":"price_test_usage_pack_200","ATOM_GRANT_PRICE":"price_test_atom_grant","OKOU_PRICE_CUSTOM_CREDITS":"price_test_custom_credits","OKOU_PRICE_CUSTOM_CREDIT_UNIT":"price_test_custom_credit_unit","OKOU_PRICE_CONCURRENCY":"price_test_concurrency","GMAIL_PUBSUB_TOPIC_NAME":"projects/github/topics/gmail","GMAIL_PUBSUB_PUSH_AUDIENCE":"https://api.github.test/api/webhooks/gmail","GMAIL_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL":"gmail-push@github.test","GOOGLE_WORKSPACE_EVENTS_PUBSUB_TOPIC_NAME":"projects/github/topics/google-workspace-events","GOOGLE_WORKSPACE_EVENTS_PUBSUB_PUSH_AUDIENCE":"https://api.github.test/api/webhooks/google-workspace-events","GOOGLE_WORKSPACE_EVENTS_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL":"workspace-events-push@github.test"}'
  repo_vars_json="$(jq -c '. + {OKOU_PUBLIC_ARTIFACTS_BASE_URL: "https://cdn.okou.test", OKOU_PUBLIC_HOST_DOMAIN: "okou.app", OKOU_HOST_SCHEME: "https", OKOU_ONE_TIME_CAMPAIGN: "test-campaign"}' <<< "$repo_vars_json")"
  repo_secrets_json='{"R2_PRIVATE_ARTIFACTS_ACCESS_KEY_ID":"private-prod-key","R2_PRIVATE_ARTIFACTS_SECRET_ACCESS_KEY":"private-prod-secret","R2_PRIVATE_ARTIFACTS_ACCESS_KEY_ID_DEV":"private-dev-key","R2_PRIVATE_ARTIFACTS_SECRET_ACCESS_KEY_DEV":"private-dev-secret","GH_OAUTH_CLIENT_SECRET":"github-gh-client-secret","SLACK_OAUTH_CLIENT_SECRET":"github-slack-client-secret","GOOGLE_ADS_DEVELOPER_TOKEN":"github-google-ads-secret","OKOU_MAPS_GOOGLE_MAPS_TOKEN":"github-google-maps-token","OKOU_WEATHER_GOOGLE_WEATHER_TOKEN":"github-google-weather-token","OKOU_FINANCE_APIDOJO_TOKEN":"github-apidojo-token","OKOU_SEO_DATAFORSEO_LOGIN":"github-dataforseo-login","OKOU_SEO_DATAFORSEO_PASSWORD":"github-dataforseo-password","OKOU_BROWSER_USE_API_KEY":"github-browser-use-api-key","OKOU_SCRAPE_FIRECRAWL_TOKEN":"github-firecrawl-token","OKOU_WEB_SEARCH_PERPLEXITY_TOKEN":"github-perplexity-token","OKOU_SOCIAL_SOCIALKIT_TOKEN":"github-socialkit-token","STEAM_WEB_API_KEY":"github-steam-web-api-key","FINICITY_APP_KEY":"github-finicity-app-key","FINICITY_APP_SECRET":"github-finicity-app-secret","OKOU_MACHINE_SECRET_KEY":"github-atom-machine-secret","MICROSOFT_TEAMS_BOT_APP_PASSWORD":"github-teams-bot-app-password","VERCEL_AUTOMATION_BYPASS_SECRET":"github-vercel-bypass-secret","CLOUDFLARE_BROWSER_RENDERING_API_TOKEN":"github-cloudflare-browser-rendering-token","ARTIFACT_PREVIEW_WAF_SECRET":"github-artifact-preview-waf-secret","JOGGAI_WEBHOOK_SECRET":"github-joggai-webhook-secret","HEYGEN_API_KEY":"github-heygen-api-key","STRIPE_WEBHOOK_SECRET":"github-stripe-billing-webhook-secret","STRIPE_AUTOMATION_WEBHOOK_SECRET":"github-stripe-automation-webhook-secret"}'
  if [[ "$branded_config" == "empty" ]]; then
    repo_vars_json="$(jq -c 'with_entries(select(.key | startswith("OKOU_") | not))' <<< "$repo_vars_json")"
    repo_secrets_json="$(jq -c 'with_entries(select(.key | startswith("OKOU_") | not))' <<< "$repo_secrets_json")"
  fi
  # Repository defaults; the caller supplies GitHub Environment overrides in
  # the same resolved vars object used by the deployment workflow.
  repo_vars_json="$(jq -c '. + {GCP_LLM_PROJECT_ID: "vm0-ai-488909", GCP_LLM_WORKLOAD_IDENTITY_PROVIDER: "projects/662642595011/locations/global/workloadIdentityPools/vercel-vm0-api/providers/vercel", GCP_LLM_SERVICE_ACCOUNT_EMAIL: "llm-dev@vm0-ai-488909.iam.gserviceaccount.com"}' <<< "$repo_vars_json")"
  repo_vars_json="$(jq -c --argjson github_app_vars "$github_app_vars_json" '. + $github_app_vars' <<< "$repo_vars_json")"
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
    INPUT_CLI_PKG_URL="$input_cli_pkg_url" \
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
    "https://static.okou.io/okou-cli/test-sha/package.tgz" \
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
    "https://static.okou.io/okou-cli/test-sha/package.tgz" \
    canonical \
    "" \
    "" \
    pr-123 \
    "https://pr-123-api-backend.okou.test" \
    "$repo_secrets_json"
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
    "https://static.okou.io/okou-cli/test-sha/package.tgz" \
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

api_backend_url_absent_dir="$(mktemp -d)"
TEMP_DIRS+=("$api_backend_url_absent_dir")
api_backend_url_absent_output="$(
  run_action \
    "$(build_doppler_secrets_json)" \
    "$api_backend_url_absent_dir" \
    api \
    production \
    "https://static.okou.io/okou-cli/test-sha/package.tgz" \
    canonical \
    "" \
    "" \
    pr-123 \
    "" \
    2>&1
)"
api_backend_url_absent_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${api_backend_url_absent_dir}/github-output")"
assert_contains "$api_backend_url_absent_output" "Rendered"
assert_api_backend_url_absent "$api_backend_url_absent_env_file"
assert_env_value "$api_backend_url_absent_env_file" PUBLIC_ARTIFACT_SHARES_BASE_URL "https://a.okou.io"
assert_env_value "$api_backend_url_absent_env_file" FEISHU_CALLBACK_BASE_URL ""
assert_env_value "$api_backend_url_absent_env_file" FINICITY_WEBHOOK_BASE_URL ""

success_dir="$(mktemp -d)"
TEMP_DIRS+=("$success_dir")
success_output="$(run_action "$(build_doppler_secrets_json)" "$success_dir" 2>&1)"
success_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${success_dir}/github-output")"
assert_contains "$success_output" "Rendered"
assert_no_fixture_secret_values "$success_output"
assert_machine_secret_values_absent_from_output "$success_output" "github-atom-machine-secret"
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
assert_env_value "$success_env_file" OKOU_MAPS_GOOGLE_MAPS_TOKEN "github-google-maps-token"
assert_env_value "$success_env_file" OKOU_WEATHER_GOOGLE_WEATHER_TOKEN "github-google-weather-token"
assert_env_value "$success_env_file" OKOU_FINANCE_APIDOJO_TOKEN "github-apidojo-token"
assert_env_value "$success_env_file" OKOU_SEO_DATAFORSEO_LOGIN "github-dataforseo-login"
assert_env_value "$success_env_file" OKOU_SEO_DATAFORSEO_PASSWORD "github-dataforseo-password"
assert_env_value "$success_env_file" OKOU_BROWSER_USE_API_KEY "github-browser-use-api-key"
assert_env_value "$success_env_file" OKOU_SCRAPE_FIRECRAWL_TOKEN "github-firecrawl-token"
assert_env_value "$success_env_file" OKOU_WEB_SEARCH_PERPLEXITY_TOKEN "github-perplexity-token"
assert_env_value "$success_env_file" OKOU_SOCIAL_SOCIALKIT_TOKEN "github-socialkit-token"
assert_env_value "$success_env_file" STEAM_WEB_API_KEY "github-steam-web-api-key"
assert_env_value "$success_env_file" FINICITY_APP_KEY "github-finicity-app-key"
assert_env_value "$success_env_file" FINICITY_APP_SECRET "github-finicity-app-secret"
assert_env_value "$success_env_file" FINICITY_PARTNER_ID "github-finicity-partner-id"
assert_env_value "$success_env_file" ATOM_URL "https://tunnel-yuma-atom-api.vm7.ai"
assert_machine_secret_canonical "$success_env_file" "github-atom-machine-secret"
assert_env_value "$success_env_file" VERCEL_AUTOMATION_BYPASS_SECRET "github-vercel-bypass-secret"
assert_env_key_count "$success_env_file" OKOU_PREVIEW_JOB_REF 1
assert_env_value "$success_env_file" OKOU_PREVIEW_JOB_REF "pr-123"
assert_api_backend_url_canonical "$success_env_file" "https://pr-123-api-backend.okou.test"
assert_google_llm_config "$success_env_file" "llm-dev@vm0-ai-488909.iam.gserviceaccount.com"
assert_env_value "$success_env_file" FEISHU_CALLBACK_BASE_URL "https://pr-123-api-backend.okou.test"
assert_env_value "$success_env_file" FINICITY_WEBHOOK_BASE_URL "https://pr-123-api-backend.okou.test"
assert_web_url_canonical "$success_env_file" "https://pr-123-www.okou.test"
assert_env_value "$success_env_file" CLI_PKG_URL "https://static.okou.io/okou-cli/test-sha/package.tgz"
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
empty_job_ref_output="$(run_action "$(build_doppler_secrets_json)" "$empty_job_ref_dir" api preview "https://static.okou.io/okou-cli/test-sha/package.tgz" canonical "" "" "" 2>&1)"
empty_job_ref_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${empty_job_ref_dir}/github-output")"
assert_contains "$empty_job_ref_output" "Rendered"
assert_preview_job_ref_absent "$empty_job_ref_env_file"
assert_debug_canonical "$empty_job_ref_env_file"
assert_api_backend_url_canonical "$empty_job_ref_env_file" "https://pr-123-api-backend.okou.test"
assert_machine_secret_canonical "$empty_job_ref_env_file" "github-atom-machine-secret"

empty_dir="$(mktemp -d)"
TEMP_DIRS+=("$empty_dir")
empty_output="$(run_action "$(build_doppler_secrets_json)" "$empty_dir" api preview "https://static.okou.io/okou-cli/test-sha/package.tgz" empty 2>&1)"
empty_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${empty_dir}/github-output")"
assert_contains "$empty_output" "Rendered"
assert_no_fixture_secret_values "$empty_output"
assert_debug_canonical "$empty_env_file"
assert_api_backend_url_canonical "$empty_env_file" "https://pr-123-api-backend.okou.test"
assert_machine_secret_absent "$empty_env_file"
assert_env_value "$empty_env_file" OKOU_PUBLIC_ARTIFACTS_BASE_URL ""
assert_env_value "$empty_env_file" OKOU_PUBLIC_HOST_DOMAIN ""
assert_env_value "$empty_env_file" OKOU_MAPS_GOOGLE_MAPS_TOKEN ""
assert_env_value "$empty_env_file" OKOU_SOCIAL_SOCIALKIT_TOKEN ""
assert_env_value "$empty_env_file" OKOU_SEO_DATAFORSEO_LOGIN ""
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
assert_env_absent_value "$production_web_env_file" "CLI_PKG_URL="
assert_env_absent_value "$production_web_env_file" "JOGGAI_WEBHOOK_SECRET="
assert_env_absent_value "$production_web_env_file" "HEYGEN_API_KEY="
assert_env_value "$production_web_env_file" OKOU_WEATHER_GOOGLE_WEATHER_TOKEN "github-google-weather-token"
assert_env_value "$production_web_env_file" OKOU_FINANCE_APIDOJO_TOKEN "github-apidojo-token"
assert_env_absent_value "$production_web_env_file" "OKOU_SEO_DATAFORSEO_LOGIN="
assert_env_absent_value "$production_web_env_file" "OKOU_SEO_DATAFORSEO_PASSWORD="
assert_env_value "$production_web_env_file" OKOU_SCRAPE_FIRECRAWL_TOKEN "github-firecrawl-token"
assert_env_value "$production_web_env_file" OKOU_WEB_SEARCH_PERPLEXITY_TOKEN "github-perplexity-token"
assert_env_absent_value "$production_web_env_file" "OKOU_SOCIAL_SOCIALKIT_TOKEN="
assert_env_absent_value "$production_web_env_file" "OKOU_BROWSER_USE_API_KEY="
assert_env_absent_value "$production_web_env_file" "github-cloudflare-browser-rendering-token"
assert_env_absent_value "$production_web_env_file" "github-artifact-preview-waf-secret"

production_api_dir="$(mktemp -d)"
TEMP_DIRS+=("$production_api_dir")
production_api_output="$(run_action "$(build_doppler_secrets_json)" "$production_api_dir" api production "https://static.okou.io/okou-cli/test-sha/package.tgz" canonical '{"GCP_LLM_SERVICE_ACCOUNT_EMAIL":"llm-prod@vm0-ai-488909.iam.gserviceaccount.com"}' 2>&1)"
production_api_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${production_api_dir}/github-output")"
assert_contains "$production_api_output" "Rendered"
assert_no_fixture_secret_values "$production_api_output"
assert_machine_secret_values_absent_from_output "$production_api_output" "github-atom-machine-secret"
assert_env_value "$production_api_env_file" OKOU_HOST_SCHEME "https"
assert_debug_absent "$production_api_env_file"
assert_google_llm_config "$production_api_env_file" "llm-prod@vm0-ai-488909.iam.gserviceaccount.com"
assert_env_value "$production_api_env_file" MAILCHIMP_OAUTH_CLIENT_ID "doppler-MAILCHIMP_OAUTH_CLIENT_ID"
assert_env_value "$production_api_env_file" MAILCHIMP_OAUTH_CLIENT_SECRET "doppler-MAILCHIMP_OAUTH_CLIENT_SECRET"
assert_env_value "$production_api_env_file" CAL_COM_OAUTH_CLIENT_ID "doppler-CAL_COM_OAUTH_CLIENT_ID"
assert_env_value "$production_api_env_file" CAL_COM_OAUTH_CLIENT_SECRET "doppler-CAL_COM_OAUTH_CLIENT_SECRET"
assert_env_value "$production_api_env_file" R2_PRIVATE_ARTIFACTS_BUCKET_NAME "user-artifact-private-prod"
assert_env_value "$production_api_env_file" R2_PRIVATE_ARTIFACTS_ACCESS_KEY_ID "private-prod-key"
assert_env_value "$production_api_env_file" R2_PRIVATE_ARTIFACTS_SECRET_ACCESS_KEY "private-prod-secret"
assert_web_url_canonical "$production_api_env_file" "https://pr-123-www.okou.test"
assert_api_backend_url_canonical "$production_api_env_file" "https://pr-123-api-backend.okou.test"
assert_env_value "$production_api_env_file" FEISHU_CALLBACK_BASE_URL "https://pr-123-api-backend.okou.test"
assert_env_value "$production_api_env_file" FINICITY_WEBHOOK_BASE_URL "https://pr-123-api-backend.okou.test"
assert_env_value "$production_api_env_file" CLI_PKG_URL "https://static.okou.io/okou-cli/test-sha/package.tgz"
assert_env_value "$production_api_env_file" ATOM_URL "https://atom.github.test"
assert_machine_secret_canonical "$production_api_env_file" "github-atom-machine-secret"
assert_env_value "$production_api_env_file" JOGGAI_WEBHOOK_SECRET "github-joggai-webhook-secret"
assert_env_value "$production_api_env_file" HEYGEN_API_KEY "github-heygen-api-key"
assert_env_value "$production_api_env_file" MICROSOFT_TEAMS_BOT_APP_ID "github-teams-bot-app-id"
assert_env_value "$production_api_env_file" MICROSOFT_TEAMS_BOT_APP_PASSWORD "github-teams-bot-app-password"
assert_env_value "$production_api_env_file" MICROSOFT_TEAMS_APP_TENANT_ID "github-teams-app-tenant-id"
assert_env_value "$production_api_env_file" OKOU_WEATHER_GOOGLE_WEATHER_TOKEN "github-google-weather-token"
assert_env_value "$production_api_env_file" OKOU_FINANCE_APIDOJO_TOKEN "github-apidojo-token"
assert_env_value "$production_api_env_file" OKOU_SEO_DATAFORSEO_LOGIN "github-dataforseo-login"
assert_env_value "$production_api_env_file" OKOU_SEO_DATAFORSEO_PASSWORD "github-dataforseo-password"
assert_env_value "$production_api_env_file" OKOU_BROWSER_USE_API_KEY "github-browser-use-api-key"
assert_env_value "$production_api_env_file" OKOU_SCRAPE_FIRECRAWL_TOKEN "github-firecrawl-token"
assert_env_value "$production_api_env_file" OKOU_WEB_SEARCH_PERPLEXITY_TOKEN "github-perplexity-token"
assert_env_value "$production_api_env_file" OKOU_SOCIAL_SOCIALKIT_TOKEN "github-socialkit-token"
assert_env_absent_value "$production_api_env_file" "ONBOARDING_URL="
assert_env_value "$production_api_env_file" CLOUDFLARE_BROWSER_RENDERING_API_TOKEN "github-cloudflare-browser-rendering-token"
assert_env_value "$production_api_env_file" ARTIFACT_PREVIEW_WAF_SECRET "github-artifact-preview-waf-secret"
assert_env_value "$production_api_env_file" STRIPE_WEBHOOK_SECRET "github-stripe-billing-webhook-secret"
assert_env_value "$production_api_env_file" STRIPE_AUTOMATION_WEBHOOK_SECRET "github-stripe-automation-webhook-secret"
assert_env_absent_value "$production_api_env_file" "doppler-stripe-billing-webhook-secret"
assert_env_absent_value "$production_api_env_file" "doppler-stripe-automation-webhook-secret"
assert_preview_job_ref_absent "$production_api_env_file"

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

for oauth_key in MAILCHIMP_OAUTH_CLIENT_ID MAILCHIMP_OAUTH_CLIENT_SECRET CAL_COM_OAUTH_CLIENT_ID CAL_COM_OAUTH_CLIENT_SECRET; do
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

missing_cli_pkg_dir="$(mktemp -d)"
TEMP_DIRS+=("$missing_cli_pkg_dir")
status=0
missing_cli_pkg_output="$(run_action "$(build_doppler_secrets_json)" "$missing_cli_pkg_dir" api preview "" 2>&1)" || status=$?
if [[ "$status" -eq 0 ]]; then
  fail "expected missing API CLI package URL to fail"
fi
assert_contains "$missing_cli_pkg_output" "::error::cli-pkg-url is required for API deployments"

echo "web-api-env-action-test: ok"
