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
  value="$(awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; count++ } END { if (count != 1) exit 1 }' "$env_file")" ||
    fail "expected exactly one ${key} in ${env_file}"
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
  local doppler_vars_json="$2"
  local suffix
  local expected
  for suffix in "${GITHUB_APP_VAR_SUFFIXES[@]}" "${GITHUB_APP_SECRET_SUFFIXES[@]}"; do
    expected="$(jq -r --arg key "GITHUB_APP_${suffix}" '.[$key] // ""' <<< "$doppler_vars_json")"
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
        STRIPE_AUTOMATION_WEBHOOK_SECRET: "doppler-stripe-automation-webhook-secret",
        SLACK_SIGNING_SECRET: "doppler-slack-signing-secret",
        TELEGRAM_OFFICIAL_BOT_TOKEN: "doppler-telegram-bot-token",
        TELEGRAM_OFFICIAL_WEBHOOK_SECRET: "doppler-telegram-webhook-secret",
        AGENTPHONE_API_KEY: "doppler-agentphone-api-key",
        AGENTPHONE_WEBHOOK_SECRET: "doppler-agentphone-webhook-secret",
        RESEND_API_KEY: "doppler-resend-api-key",
        RESEND_WEBHOOK_SECRET: "doppler-resend-webhook-secret",
        GOOGLE_ADS_DEVELOPER_TOKEN: "doppler-google-ads-secret",
        STEAM_WEB_API_KEY: "doppler-steam-web-api-key",
        FINICITY_APP_KEY: "doppler-finicity-app-key",
        FINICITY_APP_SECRET: "doppler-finicity-app-secret",
        MICROSOFT_TEAMS_BOT_APP_PASSWORD: "doppler-teams-bot-app-password"
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

  repo_vars_json='{"GH_OAUTH_CLIENT_ID":"github-gh-client-id","SLACK_OAUTH_CLIENT_ID":"github-slack-client-id","GOOGLE_ADS_DEVELOPER_TOKEN":"github-google-ads-var","FINICITY_PARTNER_ID":"github-finicity-partner-id","LINK_STRIPE_PUBLISHABLE_KEY":"pk_live_github_link_fixture","POSTHOG_KEY":"github-posthog-key","POSTHOG_HOST":"https://posthog.github.test","ATOM_URL":"https://atom.github.test","STRIPE_OAUTH_CLIENT_ID":"ca_test_connect_client","STRIPE_CONCURRENCY_PORTAL_CONFIGURATION_ID":"bpc_test_concurrency","MICROSOFT_TEAMS_BOT_APP_ID":"github-teams-bot-app-id","MICROSOFT_TEAMS_APP_TENANT_ID":"github-teams-app-tenant-id","OKOU_PRICE_PRO":"price_test_pro","OKOU_PRICE_TEAM":"price_test_team","OKOU_PRICE_USAGE_PACK_PLAN_PRO":"price_test_usage_pack_plan_pro","OKOU_PRICE_USAGE_PACK_PLAN_TEAM":"price_test_usage_pack_plan_team","OKOU_PRICE_USAGE_PACK_20":"price_test_usage_pack_20","OKOU_PRICE_USAGE_PACK_50":"price_test_usage_pack_50","OKOU_PRICE_USAGE_PACK_100":"price_test_usage_pack_100","OKOU_PRICE_USAGE_PACK_200":"price_test_usage_pack_200","ATOM_GRANT_PRICE":"price_test_atom_grant","OKOU_PRICE_CUSTOM_CREDITS":"price_test_custom_credits","OKOU_PRICE_CUSTOM_CREDIT_UNIT":"price_test_custom_credit_unit","OKOU_PRICE_CONCURRENCY":"price_test_concurrency","GMAIL_PUBSUB_TOPIC_NAME":"projects/github/topics/gmail","GMAIL_PUBSUB_PUSH_AUDIENCE":"https://api.github.test/api/webhooks/gmail","GMAIL_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL":"gmail-push@github.test","GOOGLE_WORKSPACE_EVENTS_PUBSUB_TOPIC_NAME":"projects/github/topics/google-workspace-events","GOOGLE_WORKSPACE_EVENTS_PUBSUB_PUSH_AUDIENCE":"https://api.github.test/api/webhooks/google-workspace-events","GOOGLE_WORKSPACE_EVENTS_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL":"workspace-events-push@github.test","R2_MARKETING_HANDOFF_BUCKET_NAME":"marketing-handoff-prod","R2_MARKETING_HANDOFF_BUCKET_NAME_DEV":"marketing-handoff-dev"}'
  repo_vars_json="$(jq -c '. + {OKOU_PUBLIC_ARTIFACTS_BASE_URL: "https://cdn.okou.test", OKOU_PUBLIC_HOST_DOMAIN: "okou.app", OKOU_HOST_SCHEME: "https", OKOU_ONE_TIME_CAMPAIGN: "test-campaign"}' <<< "$repo_vars_json")"
  repo_secrets_json='{"R2_PRIVATE_ARTIFACTS_ACCESS_KEY_ID":"private-prod-key","R2_PRIVATE_ARTIFACTS_SECRET_ACCESS_KEY":"private-prod-secret","R2_PRIVATE_ARTIFACTS_ACCESS_KEY_ID_DEV":"private-dev-key","R2_PRIVATE_ARTIFACTS_SECRET_ACCESS_KEY_DEV":"private-dev-secret","GH_OAUTH_CLIENT_SECRET":"github-gh-client-secret","SLACK_OAUTH_CLIENT_SECRET":"github-slack-client-secret","GOOGLE_ADS_DEVELOPER_TOKEN":"github-google-ads-secret","OKOU_DATA_ROUTER_URL":"https://data.okou.ai/mcp","OKOU_DATA_TOKEN":"github-data-router-token","OKOU_BROWSER_USE_API_KEY":"github-browser-use-api-key","STEAM_WEB_API_KEY":"github-steam-web-api-key","LINK_OAUTH_CLIENT_ID":"github-link-client-id","LINK_OAUTH_CLIENT_SECRET":"github-link-client-secret","FINICITY_APP_KEY":"github-finicity-app-key","FINICITY_APP_SECRET":"github-finicity-app-secret","OKOU_MACHINE_SECRET_KEY":"github-atom-machine-secret","MICROSOFT_TEAMS_BOT_APP_PASSWORD":"github-teams-bot-app-password","VERCEL_AUTOMATION_BYPASS_SECRET":"github-vercel-bypass-secret","STRIPE_WEBHOOK_SECRET":"github-stripe-billing-webhook-secret","STRIPE_AUTOMATION_WEBHOOK_SECRET":"github-stripe-automation-webhook-secret","R2_MARKETING_HANDOFF_ACCESS_KEY_ID":"handoff-prod-key","R2_MARKETING_HANDOFF_SECRET_ACCESS_KEY":"handoff-prod-secret","R2_MARKETING_HANDOFF_ACCESS_KEY_ID_DEV":"handoff-dev-key","R2_MARKETING_HANDOFF_SECRET_ACCESS_KEY_DEV":"handoff-dev-secret"}'
  repo_vars_json="$(jq -c '. + {APNS_KEY_ID: "TESTKEY001", APNS_TEAM_ID: "TESTTEAM01"}' <<< "$repo_vars_json")"
  repo_vars_json="$(jq -c '. + {R2_STATIC_BUCKET_NAME: "static-releases"}' <<< "$repo_vars_json")"
  repo_secrets_json="$(jq -c '. + {
    DISCORD_OAUTH_CLIENT_SECRET: "github-discord-oauth-secret",
    R2_STATIC_ACCESS_KEY_ID: "static-release-key",
    R2_STATIC_SECRET_ACCESS_KEY: "static-release-secret",
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
  local doppler_vars_json="${4:-}"
  if [[ -z "$doppler_vars_json" ]]; then
    doppler_vars_json="{}"
  fi
  run_action \
    "$(build_doppler_secrets_json | jq -c --argjson vars "$doppler_vars_json" '. + $vars')" \
    "$test_dir" \
    api \
    preview \
    canonical \
    "$repo_vars_json" \
    "$repo_secrets_json"
}

github_app_canonical_vars_json='{"OKOU_GITHUB_APP_SLUG":" github-canonical-slug ","OKOU_GITHUB_APP_ID":"github-canonical-id","OKOU_GITHUB_APP_CLIENT_ID":"github-canonical-client-id"}'
github_app_canonical_secrets_json='{"OKOU_GITHUB_APP_CLIENT_SECRET":"github-canonical-client-secret","OKOU_GITHUB_APP_WEBHOOK_SECRET":"github-canonical-webhook-secret","OKOU_GITHUB_APP_PRIVATE_KEY":"github-canonical-private-key"}'
github_app_doppler_vars_json='{"GITHUB_APP_SLUG":" doppler-canonical-slug ","GITHUB_APP_ID":"doppler-canonical-id","GITHUB_APP_CLIENT_ID":"doppler-canonical-client-id","GITHUB_APP_CLIENT_SECRET":"doppler-canonical-client-secret","GITHUB_APP_WEBHOOK_SECRET":"doppler-canonical-webhook-secret","GITHUB_APP_PRIVATE_KEY":"doppler-canonical-private-key"}'
github_app_canonical_dir="$(mktemp -d)"
TEMP_DIRS+=("$github_app_canonical_dir")
github_app_canonical_output="$(run_github_app_action "$github_app_canonical_dir" "$github_app_canonical_vars_json" "$github_app_canonical_secrets_json" "$github_app_doppler_vars_json" 2>&1)"
github_app_canonical_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${github_app_canonical_dir}/github-output")"
assert_contains "$github_app_canonical_output" "Rendered"
assert_no_fixture_secret_values "$github_app_canonical_output"
assert_github_app_mapping_values "$github_app_canonical_env_file" "$github_app_doppler_vars_json"
assert_github_app_source_keys_absent "$github_app_canonical_env_file"

integration_config_keys='[
  "AGENTPHONE_API_KEY",
  "AGENTPHONE_WEBHOOK_SECRET",
  "LARK_OFFICIAL_APP_ID",
  "LARK_OFFICIAL_APP_SECRET",
  "LARK_OFFICIAL_VERIFICATION_TOKEN",
  "LARK_OFFICIAL_ENCRYPT_KEY",
  "FINICITY_APP_KEY",
  "FINICITY_APP_SECRET",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_WEBHOOK_SECRET",
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "MICROSOFT_TEAMS_BOT_APP_PASSWORD",
  "RESEND_API_KEY",
  "RESEND_WEBHOOK_SECRET",
  "SLACK_SIGNING_SECRET",
  "STEAM_WEB_API_KEY",
  "STRIPE_AUTOMATION_WEBHOOK_SECRET",
  "TELEGRAM_OFFICIAL_BOT_TOKEN",
  "TELEGRAM_OFFICIAL_WEBHOOK_SECRET",
  "AGENTPHONE_AGENT_ID",
  "AGENTPHONE_API_BASE_URL",
  "AGENTPHONE_PHONE_NUMBER",
  "FINICITY_PARTNER_ID",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
  "GMAIL_PUBSUB_PUSH_AUDIENCE",
  "GMAIL_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL",
  "GMAIL_PUBSUB_TOPIC_NAME",
  "GOOGLE_FORMS_PUBSUB_PUSH_AUDIENCE",
  "GOOGLE_FORMS_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL",
  "GOOGLE_FORMS_PUBSUB_TOPIC_NAME",
  "GOOGLE_WORKSPACE_EVENTS_PUBSUB_PUSH_AUDIENCE",
  "GOOGLE_WORKSPACE_EVENTS_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL",
  "GOOGLE_WORKSPACE_EVENTS_PUBSUB_TOPIC_NAME",
  "MERCURY_OAUTH_ENVIRONMENT",
  "MICROSOFT_TEAMS_APP_TENANT_ID",
  "MICROSOFT_TEAMS_BOT_APP_ID",
  "RESEND_FROM_DOMAIN",
  "TELEGRAM_OFFICIAL_BOT_USERNAME",
  "VERCEL_INTEGRATION_SLUG"
]'
gateway_config_keys='[
  "DISCORD_APPLICATION_ID",
  "DISCORD_PUBLIC_KEY",
  "DISCORD_BOT_TOKEN",
  "DISCORD_GATEWAY_SECRET",
  "DISCORD_OAUTH_CLIENT_SECRET",
  "LINK_APPROVAL_WORKER_URL",
  "LINK_APPROVAL_WORKER_SECRET",
  "LINK_APPROVAL_CONTROL_SECRET",
  "WECHAT_GATEWAY_URL",
  "WECHAT_GATEWAY_SECRET",
  "WECHAT_GATEWAY_CONTROL_SECRET"
]'

# Each render exercises all integration sources for one app and environment.
for integration_environment in preview production; do
  integration_doppler_json="$(
    jq -cn --argjson keys "$integration_config_keys" --argjson gateway_keys "$gateway_config_keys" \
      --arg scope "$integration_environment" '
      reduce ($keys + $gateway_keys)[] as $key ({}; .[$key] = ("doppler-" + $scope + "-" + $key)) |
      . + {
        DISCORD_APPLICATION_ID: "123456789012345678",
        DISCORD_PUBLIC_KEY: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        LINK_APPROVAL_WORKER_URL: ("https://link-approval-" + $scope + ".example.test"),
        WECHAT_GATEWAY_URL: ("https://wechat-" + $scope + ".example.test")
      }
    '
  )"
  integration_repo_secrets="$(
    jq -c 'with_entries(
      .key |= (if startswith("GITHUB_APP_") then "OKOU_" + . else . end)
      | .value = "github-conflicting-integration"
    )' <<< "$integration_doppler_json"
  )"
  integration_repo_vars="$(
    jq -c '. + {WHATSAPP_ALLOWED_COUNTRY_PREFIXES: "+1,+49"}' <<< "$integration_repo_secrets"
  )"
  integration_secrets="$(
    build_doppler_secrets_json | jq -c --argjson vars "$integration_doppler_json" '. + $vars'
  )"
  for integration_app in api web; do
    integration_dir="$(mktemp -d)"
    TEMP_DIRS+=("$integration_dir")
    integration_output="$(
      run_action "$integration_secrets" "$integration_dir" "$integration_app" "$integration_environment" \
        canonical "$integration_repo_vars" "$integration_repo_secrets" 2>&1
    )"
    integration_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${integration_dir}/github-output")"
    if [[ ! -f "$integration_env_file" || ! -r "$integration_env_file" || ! -s "$integration_env_file" ]]; then
      fail "expected a readable, nonempty rendered environment for ${integration_app}/${integration_environment}"
    fi
    assert_no_fixture_secret_values "$integration_output"
    assert_env_absent_value "$integration_env_file" "github-conflicting-integration"
    if [[ "$integration_app" == api ]]; then
      integration_rows="$(jq -er 'to_entries[] | [.key, .value] | @tsv' <<< "$integration_doppler_json")"
      while IFS=$'\t' read -r integration_key integration_value; do
        assert_env_value "$integration_env_file" "$integration_key" "$integration_value"
      done <<< "$integration_rows"
      assert_env_value "$integration_env_file" WHATSAPP_ALLOWED_COUNTRY_PREFIXES "+1,+49"
    else
      integration_rows="$(jq -er --argjson keys "$gateway_config_keys" '$keys[] as $key | [$key, .[$key]] | @tsv' \
        <<< "$integration_doppler_json")"
      while IFS=$'\t' read -r integration_key integration_value; do
        assert_env_key_absent "$integration_env_file" "$integration_key"
        assert_env_absent_value "$integration_env_file" "$integration_value"
      done <<< "$integration_rows"
      assert_env_key_absent "$integration_env_file" WHATSAPP_ALLOWED_COUNTRY_PREFIXES
    fi
  done
done

machine_secret_dir="$(mktemp -d)"
TEMP_DIRS+=("$machine_secret_dir")
machine_secret_output="$(run_action \
  "$(build_doppler_secrets_json)" "$machine_secret_dir" api preview canonical \
  "" "" pr-123 "https://pr-123-api-backend.okou.test" \
  '{"OKOU_MACHINE_SECRET_KEY":" preview-canonical-machine-secret=bytes "}' 2>&1)"
machine_secret_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${machine_secret_dir}/github-output")"
assert_machine_secret_values_absent_from_output "$machine_secret_output" " preview-canonical-machine-secret=bytes "
assert_machine_secret_canonical "$machine_secret_env_file" " preview-canonical-machine-secret=bytes "

api_backend_url_absent_dir="$(mktemp -d)"
TEMP_DIRS+=("$api_backend_url_absent_dir")
status=0
api_backend_url_absent_output="$(
  run_action "$(build_doppler_secrets_json)" "$api_backend_url_absent_dir" api preview canonical "" "" pr-123 "" 2>&1
)" || status=$?
if [[ "$status" -eq 0 || -e "${api_backend_url_absent_dir}/web-api-api-preview.env" ]]; then
  fail "missing API backend URL must fail before creating an environment file"
fi
assert_contains "$api_backend_url_absent_output" "::error::api-backend-url is required for API deployments"

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
    assert_api_backend_url_canonical "$mcp_env_file" "$mcp_api_url"
    assert_env_value "$mcp_env_file" MCP_RESOURCE_URL "$mcp_resource"
    assert_env_value "$mcp_env_file" MCP_OAUTH_ISSUER "$mcp_issuer"
    assert_env_value "$mcp_env_file" FEISHU_CALLBACK_BASE_URL "$mcp_api_url"
    assert_env_value "$mcp_env_file" FINICITY_WEBHOOK_BASE_URL "$mcp_api_url"
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
assert_github_app_empty_outputs "$success_env_file"
assert_github_app_source_keys_absent "$success_env_file"

# Render an operator credential through the same API deployment boundary, and
# ensure web deployments never receive these cross-tenant service capabilities.
for history_app in api web; do
  history_dir="$(mktemp -d)"
  TEMP_DIRS+=("$history_dir")
  history_output="$(run_action "$(build_doppler_secrets_json)" "$history_dir" \
    "$history_app" preview canonical '{"MARKETING_REWARDS_EVENTS_ORIGIN":"https://events.example.test"}' \
    '{"MARKETING_REWARDS_EXPORT_SECRET":"history-export-operator-fixture-123456789","MARKETING_REWARDS_RECEIPT_SECRET":"receipt-lookup-service-fixture-123456789","MARKETING_REWARDS_EVENTS_SECRET":"event-delivery-service-fixture-123456789"}' 2>&1)"
  history_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${history_dir}/github-output")"
  assert_not_contains "$history_output" "history-export-operator-fixture-123456789"
  assert_not_contains "$history_output" "receipt-lookup-service-fixture-123456789"
  assert_not_contains "$history_output" "event-delivery-service-fixture-123456789"
  if [[ "$history_app" == api ]]; then
    assert_env_value "$history_env_file" MARKETING_REWARDS_EXPORT_SECRET "history-export-operator-fixture-123456789"
    assert_env_value "$history_env_file" MARKETING_REWARDS_RECEIPT_SECRET "receipt-lookup-service-fixture-123456789"
    assert_env_value "$history_env_file" MARKETING_REWARDS_EVENTS_SECRET "event-delivery-service-fixture-123456789"
    assert_env_value "$history_env_file" MARKETING_REWARDS_EVENTS_ORIGIN "https://events.example.test"
  else
    assert_env_key_absent "$history_env_file" MARKETING_REWARDS_EXPORT_SECRET
    assert_env_key_absent "$history_env_file" MARKETING_REWARDS_RECEIPT_SECRET
    assert_env_key_absent "$history_env_file" MARKETING_REWARDS_EVENTS_SECRET
    assert_env_key_absent "$history_env_file" MARKETING_REWARDS_EVENTS_ORIGIN
  fi
done
assert_env_value "$success_env_file" MARKETING_REWARDS_EXPORT_SECRET ""
assert_env_value "$success_env_file" MARKETING_REWARDS_RECEIPT_SECRET ""
assert_env_value "$success_env_file" MARKETING_REWARDS_EVENTS_SECRET ""
assert_env_value "$success_env_file" MARKETING_REWARDS_EVENTS_ORIGIN ""
assert_env_value "$success_env_file" R2_STATIC_BUCKET_NAME "static-releases"
assert_env_value "$success_env_file" R2_STATIC_ACCESS_KEY_ID "static-release-key"
assert_env_value "$success_env_file" R2_STATIC_SECRET_ACCESS_KEY "static-release-secret"
assert_not_contains "$success_output" "static-release-secret"
assert_env_value "$success_env_file" R2_MARKETING_HANDOFF_BUCKET_NAME "marketing-handoff-dev"
assert_env_value "$success_env_file" R2_MARKETING_HANDOFF_ACCESS_KEY_ID "handoff-dev-key"
assert_env_value "$success_env_file" R2_MARKETING_HANDOFF_SECRET_ACCESS_KEY "handoff-dev-secret"
assert_not_contains "$success_output" "handoff-dev-secret"
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
assert_env_value "$success_env_file" BOX_OAUTH_CLIENT_ID "doppler-BOX_OAUTH_CLIENT_ID"
assert_env_value "$success_env_file" BOX_OAUTH_CLIENT_SECRET "doppler-BOX_OAUTH_CLIENT_SECRET"
assert_env_value "$success_env_file" QUICKBOOKS_OAUTH_CLIENT_ID "doppler-QUICKBOOKS_OAUTH_CLIENT_ID"
assert_env_value "$success_env_file" QUICKBOOKS_OAUTH_CLIENT_SECRET "doppler-QUICKBOOKS_OAUTH_CLIENT_SECRET"
assert_env_value "$success_env_file" RAMP_OAUTH_CLIENT_ID "doppler-RAMP_OAUTH_CLIENT_ID"
assert_env_value "$success_env_file" RAMP_OAUTH_CLIENT_SECRET "doppler-RAMP_OAUTH_CLIENT_SECRET"
assert_env_value "$success_env_file" TIKTOK_ADS_OAUTH_CLIENT_ID "doppler-TIKTOK_ADS_OAUTH_CLIENT_ID"
assert_env_value "$success_env_file" TIKTOK_ADS_OAUTH_CLIENT_SECRET "doppler-TIKTOK_ADS_OAUTH_CLIENT_SECRET"
assert_env_value "$success_env_file" TIKTOK_OAUTH_CLIENT_ID "doppler-TIKTOK_OAUTH_CLIENT_ID"
assert_env_value "$success_env_file" TIKTOK_OAUTH_CLIENT_SECRET "doppler-TIKTOK_OAUTH_CLIENT_SECRET"
assert_env_value "$success_env_file" MICROSOFT_TEAMS_BOT_APP_ID ""
assert_env_value "$success_env_file" MICROSOFT_TEAMS_BOT_APP_PASSWORD "doppler-teams-bot-app-password"
assert_env_value "$success_env_file" MICROSOFT_TEAMS_APP_TENANT_ID ""
assert_env_value "$success_env_file" GOOGLE_ADS_DEVELOPER_TOKEN "doppler-google-ads-secret"
assert_env_value "$success_env_file" OKOU_BROWSER_USE_API_KEY "github-browser-use-api-key"
assert_env_value "$success_env_file" OKOU_BROWSER_USE_EXTENSION_ID "$BROWSER_EXTENSION_ID"
assert_env_value "$success_env_file" STEAM_WEB_API_KEY "doppler-steam-web-api-key"
assert_env_value "$success_env_file" LINK_OAUTH_CLIENT_ID "doppler-link-client-id"
assert_env_value "$success_env_file" LINK_OAUTH_CLIENT_SECRET "doppler-link-client-secret"
assert_env_absent_value "$success_env_file" "github-link-client-id"
assert_env_absent_value "$success_env_file" "github-link-client-secret"
assert_not_contains "$success_output" "doppler-link-client-secret"
assert_env_value "$success_env_file" LINK_STRIPE_PUBLISHABLE_KEY "pk_live_link_fixture"
assert_env_value "$success_env_file" FINICITY_APP_KEY "doppler-finicity-app-key"
assert_env_value "$success_env_file" FINICITY_APP_SECRET "doppler-finicity-app-secret"
assert_env_value "$success_env_file" FINICITY_PARTNER_ID ""
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
assert_env_value "$success_env_file" GMAIL_PUBSUB_TOPIC_NAME ""
assert_env_value "$success_env_file" GMAIL_PUBSUB_PUSH_AUDIENCE ""
assert_env_value "$success_env_file" GMAIL_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL ""
assert_env_value "$success_env_file" GOOGLE_WORKSPACE_EVENTS_PUBSUB_TOPIC_NAME ""
assert_env_value "$success_env_file" GOOGLE_WORKSPACE_EVENTS_PUBSUB_PUSH_AUDIENCE ""
assert_env_value "$success_env_file" GOOGLE_WORKSPACE_EVENTS_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL ""
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
assert_env_key_absent "$production_web_env_file" R2_STATIC_ACCESS_KEY_ID
assert_env_key_absent "$production_web_env_file" R2_STATIC_SECRET_ACCESS_KEY
assert_env_value "$production_api_env_file" R2_STATIC_BUCKET_NAME "static-releases"
assert_env_value "$production_api_env_file" R2_STATIC_ACCESS_KEY_ID "static-release-key"
assert_env_value "$production_api_env_file" R2_STATIC_SECRET_ACCESS_KEY "static-release-secret"
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
assert_env_value "$production_api_env_file" R2_MARKETING_HANDOFF_BUCKET_NAME "marketing-handoff-prod"
assert_env_value "$production_api_env_file" R2_MARKETING_HANDOFF_ACCESS_KEY_ID "handoff-prod-key"
assert_env_value "$production_api_env_file" R2_MARKETING_HANDOFF_SECRET_ACCESS_KEY "handoff-prod-secret"
assert_env_value "$production_api_env_file" R2_PRIVATE_ARTIFACTS_BUCKET_NAME "user-artifact-private-prod"
assert_env_value "$production_api_env_file" R2_PRIVATE_ARTIFACTS_ACCESS_KEY_ID "private-prod-key"
assert_env_value "$production_api_env_file" R2_PRIVATE_ARTIFACTS_SECRET_ACCESS_KEY "private-prod-secret"
assert_web_url_canonical "$production_api_env_file" "https://pr-123-www.okou.test"
assert_api_backend_url_canonical "$production_api_env_file" "https://pr-123-api-backend.okou.test"
assert_env_value "$production_api_env_file" FEISHU_CALLBACK_BASE_URL "https://pr-123-api-backend.okou.test"
assert_env_value "$production_api_env_file" FINICITY_WEBHOOK_BASE_URL "https://pr-123-api-backend.okou.test"
assert_env_value "$production_api_env_file" ATOM_URL "https://atom.github.test"
assert_machine_secret_canonical "$production_api_env_file" "github-atom-machine-secret"
assert_env_value "$production_api_env_file" MICROSOFT_TEAMS_BOT_APP_ID ""
assert_env_value "$production_api_env_file" MICROSOFT_TEAMS_BOT_APP_PASSWORD "doppler-teams-bot-app-password"
assert_env_value "$production_api_env_file" MICROSOFT_TEAMS_APP_TENANT_ID ""
assert_env_value "$production_api_env_file" OKOU_BROWSER_USE_API_KEY "github-browser-use-api-key"
assert_env_value "$production_api_env_file" OKOU_BROWSER_USE_EXTENSION_ID "$BROWSER_EXTENSION_ID"
assert_env_value "$production_api_env_file" STRIPE_WEBHOOK_SECRET "github-stripe-billing-webhook-secret"
assert_env_value "$production_api_env_file" STRIPE_AUTOMATION_WEBHOOK_SECRET "doppler-stripe-automation-webhook-secret"
assert_env_absent_value "$production_api_env_file" "doppler-stripe-billing-webhook-secret"
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

# Both default API renders have no Doppler Discord config.
for discord_env_file in "$success_env_file" "$production_api_env_file"; do
  for discord_key in DISCORD_APPLICATION_ID DISCORD_PUBLIC_KEY DISCORD_BOT_TOKEN DISCORD_GATEWAY_SECRET DISCORD_OAUTH_CLIENT_SECRET; do
    assert_env_key_count "$discord_env_file" "$discord_key" 1
    assert_env_value "$discord_env_file" "$discord_key" ""
  done
  assert_env_absent_value "$discord_env_file" "github-discord-oauth-secret"
done

missing_dir="$(mktemp -d)"
TEMP_DIRS+=("$missing_dir")
status=0
missing_output="$(run_action "$(build_doppler_secrets_json GH_OAUTH_CLIENT_SECRET)" "$missing_dir" 2>&1)" || status=$?
if [[ "$status" -eq 0 || -s "${missing_dir}/github-output" ]]; then
  fail "missing Doppler OAuth client secret must stop environment publication"
fi
assert_contains "$missing_output" "::error::GH_OAUTH_CLIENT_SECRET is missing from Doppler OAuth config"
assert_no_fixture_secret_values "$missing_output"

missing_stripe_dir="$(mktemp -d)"
TEMP_DIRS+=("$missing_stripe_dir")
status=0
missing_stripe_output="$(run_action "$(build_doppler_secrets_json STRIPE_OAUTH_CLIENT_ID)" "$missing_stripe_dir" 2>&1)" || status=$?
if [[ "$status" -eq 0 || -s "${missing_stripe_dir}/github-output" ]]; then
  fail "missing Doppler OAuth client id must stop environment publication"
fi
assert_contains "$missing_stripe_output" "::error::STRIPE_OAUTH_CLIENT_ID is missing from Doppler OAuth config"
assert_no_fixture_secret_values "$missing_stripe_output"

assert_env_value "$production_api_env_file" OKOU_DATA_ROUTER_URL "https://data.okou.ai/mcp"
assert_env_value "$production_api_env_file" OKOU_DATA_TOKEN "github-data-router-token"

assert_env_value "$success_env_file" WHATSAPP_ALLOWED_COUNTRY_PREFIXES ""
assert_env_value "$production_api_env_file" WHATSAPP_ALLOWED_COUNTRY_PREFIXES ""
assert_env_key_absent "$production_web_env_file" WHATSAPP_ALLOWED_COUNTRY_PREFIXES
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
