#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/resolve-production-rollback-target.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
fake_bin="${tmp_dir}/bin"
mkdir -p "$fake_bin"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

target_commit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

cat >"${fake_bin}/git" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'git %s\n' "$*" >>"$MOCK_BOUNDARY_LOG"
case "${1:-}" in
  fetch|cat-file) exit 0 ;;
  merge-base)
    if [ "${3:-}" = "febec8a3399be74b0f14a89cb9f42e39dd5ce69f" ]; then
      [ "${MOCK_BLANK_RUNNER_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "0367d976a87fe1251fcb9b6cfe545a8b24e4f2b6" ]; then
      [ "${MOCK_BALANCE_RUNNER_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "4558c9fac46ce1a96a25745b477b32b70dab7ae6" ]; then
      [ "${MOCK_CHAT_THREAD_DRAFT_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "7a187fa0a3fe2f23a134c7cdff66ee9c7e2bdb38" ]; then
      [ "${MOCK_CHAT_THREAD_DRAFT_OWNER_KEY_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "cdeec36c168636b1a2e510e660eb6139c9c4e07a" ]; then
      [ "${MOCK_COMPUTER_USE_AUDIT_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "98b5515ae2874128734b19a17b96dc8c6c7afe47" ]; then
      [ "${MOCK_CHAT_SEARCH_GIN_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "ee863a302a6c547f94e50ec4069f70910d68bee2" ]; then
      [ "${MOCK_ADVISORY_LOCK_PREPARATION_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "84ac71914345b8360f3df43cc2cd47f0a8af7a23" ]; then
      [ "${MOCK_QUEUED_RUN_PROMOTION_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "553fc566b7e9be2cd4a8c1de314d55939b99490a" ]; then
      [ "${MOCK_UNIFIED_CHAT_QUEUE_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "fd5104417a0cf41116ce9cb9c1aeb2fa3b5e14da" ]; then
      [ "${MOCK_RUNNER_STEER_ENDPOINTS_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "45b537a596a153a91b76c3bc7223187840f52775" ]; then
      [ "${MOCK_VIDEO_GENERATION_RETIREMENT_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "77357abdb29ce96b2caf9ee679299602757844dc" ]; then
      [ "${MOCK_PI_MEMORY_LUNA_ROUTING_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "3d93ff8d4b4a07a5888e3030e69b340f40da0ad4" ]; then
      [ "${MOCK_CHAT_THREAD_SNAPSHOT_R2_ONLY_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "2222222222222222222222222222222222222222" ]; then
      [ "${MOCK_PUBLIC_BRAND_RETIREMENT_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "3333333333333333333333333333333333333333" ]; then
      [ "${MOCK_AGENT_RUN_HEARTBEAT_DROP_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "4444444444444444444444444444444444444444" ]; then
      [ "${MOCK_PERSONAL_SUBSCRIPTION_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "5555555555555555555555555555555555555555" ]; then
      [ "${MOCK_SNAPSHOT_JSONB_DROP_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "6666666666666666666666666666666666666666" ]; then
      [ "${MOCK_STRIPE_PORTAL_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "7777777777777777777777777777777777777777" ]; then
      [ "${MOCK_CHAT_EVENT_SCHEMA_HEADER_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "8888888888888888888888888888888888888888" ]; then
      [ "${MOCK_RETIRED_PREFERENCE_COLUMNS_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1" ]; then
      [ "${MOCK_CHAT_EVENT_V8_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "4242424242424242424242424242424242424242" ]; then
      [ "${MOCK_CHECKPOINT_WRITER_PREPARATION_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "1414141414141414141414141414141414141414" ]; then
      [ "${MOCK_BROWSER_SESSION_MUTATIONS_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "1212121212121212121212121212121212121212" ]; then
      [ "${MOCK_RETIRED_INTEGRATION_AGENT_TABLES_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" ]; then
      [ "${MOCK_VIDEO_MODEL_COLUMNS_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "1313131313131313131313131313131313131313" ]; then
      [ "${MOCK_IMAGE_MODEL_THREAD_COLUMNS_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "1515151515151515151515151515151515151515" ]; then
      [ "${MOCK_VIDEO_ENTITLEMENT_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "1616161616161616161616161616161616161616" ]; then
      [ "${MOCK_RETIRED_MODEL_CONFIGURATION_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "1717171717171717171717171717171717171717" ]; then
      [ "${MOCK_CHAT_THREAD_PROVIDER_PIN_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "1818181818181818181818181818181818181818" ]; then
      [ "${MOCK_DEAD_MODEL_PROVIDER_COLUMNS_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "1919191919191919191919191919191919191919" ]; then
      [ "${MOCK_CONNECTOR_CATALOG_RELEASE_2_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "3737373737373737373737373737373737373737" ]; then
      [ "${MOCK_MODEL_ROUTE_STATE_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "3838383838383838383838383838383838383838" ]; then
      [ "${MOCK_PI_STABLE_CONTEXT_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "3939393939393939393939393939393939393939" ]; then
      [ "${MOCK_PI_DEBUG_TRACE_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "4040404040404040404040404040404040404040" ]; then
      [ "${MOCK_CONNECTOR_CATALOG_PAYLOAD_INDEPENDENT_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "4141414141414141414141414141414141414141" ]; then
      [ "${MOCK_USAGE_ALLOWANCE_FLOOR_VALID:-1}" = "1" ]
    else
      [ "${MOCK_ANCESTRY_VALID:-1}" = "1" ]
    fi
    ;;
  log)
    if [[ "$*" == *1255_retire_public_brand.sql* ]]; then
      printf '%s\n' "${MOCK_PUBLIC_BRAND_RETIREMENT_COMMIT-2222222222222222222222222222222222222222}"
    elif [[ "$*" == *1259_drop_agent_runs_last_heartbeat_at.sql* ]]; then
      printf '%s\n' "${MOCK_AGENT_RUN_HEARTBEAT_DROP_COMMIT-3333333333333333333333333333333333333333}"
    elif [[ "$*" == *1260_personal_subscription_account_only.sql* ]]; then
      printf '%s\n' "${MOCK_PERSONAL_SUBSCRIPTION_COMMIT-4444444444444444444444444444444444444444}"
    elif [[ "$*" == *1261_drop_chat_thread_snapshot_jsonb.sql* ]]; then
      printf '%s\n' "${MOCK_SNAPSHOT_JSONB_DROP_COMMIT-5555555555555555555555555555555555555555}"
    elif [[ "$*" == *stripe-portal-purpose-only* ]]; then
      printf '%s\n' "${MOCK_STRIPE_PORTAL_COMMIT-6666666666666666666666666666666666666666}"
    elif [[ "$*" == *chat-event-schema-header-retired* ]]; then
      printf '%s\n' "${MOCK_CHAT_EVENT_SCHEMA_HEADER_COMMIT-7777777777777777777777777777777777777777}"
    elif [[ "$*" == *1274_drop_retired_voice_reasoning_collection_columns.sql* ]]; then
      printf '%s\n' "${MOCK_RETIRED_PREFERENCE_COLUMNS_COMMIT-8888888888888888888888888888888888888888}"
    elif [[ "$*" == *1283_drop_retired_video_model_columns.sql* ]]; then
      printf '%s\n' "${MOCK_VIDEO_MODEL_COLUMNS_COMMIT-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee}"
    elif [[ "$*" == *1287_drop_image_model_thread_columns.sql* ]]; then
      printf '%s\n' "${MOCK_IMAGE_MODEL_THREAD_COLUMNS_COMMIT-1313131313131313131313131313131313131313}"
    elif [[ "$*" == *1315_drop_retired_video_entitlement.sql* ]]; then
      printf '%s\n' "${MOCK_VIDEO_ENTITLEMENT_COMMIT-1515151515151515151515151515151515151515}"
    elif [[ "$*" == *1330_drop_retired_model_configuration_columns.sql* ]]; then
      printf '%s\n' "${MOCK_RETIRED_MODEL_CONFIGURATION_COMMIT-1616161616161616161616161616161616161616}"
    elif [[ "$*" == *1332_drop_chat_thread_provider_pin_columns.sql* ]]; then
      printf '%s\n' "${MOCK_CHAT_THREAD_PROVIDER_PIN_COMMIT-1717171717171717171717171717171717171717}"
    elif [[ "$*" == *1333_drop_dead_model_provider_columns.sql* ]]; then
      printf '%s\n' "${MOCK_DEAD_MODEL_PROVIDER_COLUMNS_COMMIT-1818181818181818181818181818181818181818}"
    elif [[ "$*" == *1334_connector_catalog_release_2_contraction.sql* ]]; then
      printf '%s\n' "${MOCK_CONNECTOR_CATALOG_RELEASE_2_COMMIT-1919191919191919191919191919191919191919}"
    elif [[ "$*" == *1338_retire_model_route_state.sql* ]]; then
      printf '%s\n' "${MOCK_MODEL_ROUTE_STATE_COMMIT-3737373737373737373737373737373737373737}"
    elif [[ "$*" == *1343_retire_pi_stable_context.sql* ]]; then
      printf '%s\n' "${MOCK_PI_STABLE_CONTEXT_COMMIT-3838383838383838383838383838383838383838}"
    elif [[ "$*" == *1345_outstanding_the_hood.sql* ]]; then
      printf '%s\n' "${MOCK_PI_DEBUG_TRACE_COMMIT-3939393939393939393939393939393939393939}"
    elif [[ "$*" == *1348_connector_catalog_payload_independent_api.sql* ]]; then
      printf '%s\n' "${MOCK_CONNECTOR_CATALOG_PAYLOAD_INDEPENDENT_COMMIT-4040404040404040404040404040404040404040}"
    elif [[ "$*" == *1356_drop_organization_usage_allowance.sql* ]]; then
      printf '%s\n' "${MOCK_USAGE_ALLOWANCE_COMMIT-4141414141414141414141414141414141414141}"
    elif [[ "$*" == *chat-event-v8* ]]; then
      printf '%s\n' "${MOCK_CHAT_EVENT_V8_COMMIT-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1}"
    elif [[ "$*" == *pi-memory-phase2-input-revision.ts* ]]; then
      printf '%s\n' "${MOCK_CHECKPOINT_WRITER_PREPARATION_COMMIT-4242424242424242424242424242424242424242}"
    elif [[ "$*" == *browser-session-mutations* ]]; then
      printf '%s\n' "${MOCK_BROWSER_SESSION_MUTATIONS_COMMIT-1414141414141414141414141414141414141414}"
    elif [[ "$*" == *1282_drop_retired_integration_agent_tables.sql* ]]; then
      printf '%s\n' "${MOCK_RETIRED_INTEGRATION_AGENT_TABLES_COMMIT-1212121212121212121212121212121212121212}"
    else
      exit 2
    fi
    ;;
  tag)
    printf 'vm0-v1.2.3\n'
    ;;
  show)
    printf '[package]\nversion = "1.2.3"\n'
    ;;
  rev-list)
    printf 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n'
    ;;
  *)
    echo "unexpected git command: $*" >&2
    exit 2
    ;;
esac
SH

cat >"${fake_bin}/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'curl %s\n' "$*" >>"$MOCK_BOUNDARY_LOG"
if [[ "$*" == *"api.vercel.com/v6/deployments"* ]]; then
  jq -n \
    --arg sha "$TARGET_COMMIT" \
    --argjson count "${MOCK_VERCEL_MATCH_COUNT:-1}" \
    '{deployments: [range(0; $count) | {
      meta: {githubCommitSha: $sha},
      state: "READY",
      target: "production",
      url: ("api-" + (tostring) + ".vercel.app")
    }]}'
  exit 0
fi

if [ "${MOCK_RUNNER_ASSETS_VALID:-1}" = "1" ]; then
  jq -n '{assets: [
    {name: "runner-v1.2.3-aarch64-linux"},
    {name: "runner-v1.2.3-x86_64-linux"}
  ]}'
else
  jq -n '{assets: [{name: "runner-v1.2.3-aarch64-linux"}]}'
fi
SH

cat >"${fake_bin}/ssh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'ssh %s\n' "$*" >>"$MOCK_BOUNDARY_LOG"
if [ "${1:-}" = "-n" ]; then shift; fi
remote=$1
host=${remote#*@}
case "$host" in
  arm-1) printf 'aarch64\n' ;;
  x86-1) printf 'x86_64\n' ;;
  *) exit 255 ;;
esac
SH
chmod +x "${fake_bin}/git" "${fake_bin}/curl" "${fake_bin}/ssh"

run_resolver() {
  local output_file=$1
  shift
  : >"$output_file"
  env -i \
    PATH="${fake_bin}:$PATH" \
    HOME="${HOME:-/tmp}" \
    AWS_METAL_RUNNER_HOSTS=arm-1,x86-1 \
    GH_TOKEN=test-github-token \
    GITHUB_OUTPUT="$output_file" \
    GITHUB_REPOSITORY=okou-ai/okou \
    METAL_USER=ci \
    MOCK_BOUNDARY_LOG="${tmp_dir}/boundaries.log" \
    TARGET_COMMIT="$target_commit" \
    VERCEL_ORG_ID=test-org \
    VERCEL_PROJECT_ID=test-project \
    VERCEL_TOKEN=test-vercel-token \
    "$@" \
    bash "$script"
}

assert_failure() {
  local expected_message=$1
  shift
  if "$@" >"${tmp_dir}/failure.out" 2>"${tmp_dir}/failure.err"; then
    fail "expected command to fail: ${expected_message}"
  fi
  grep -q "$expected_message" "${tmp_dir}/failure.err" || fail "missing failure message: ${expected_message}"
}

# A compatible API target must resolve its independently compatible Runner tag.
: >"${tmp_dir}/boundaries.log"
output_file="${tmp_dir}/success.output"
run_resolver "$output_file" >"${tmp_dir}/success.log"
grep -Fxq "git merge-base --is-ancestor 77357abdb29ce96b2caf9ee679299602757844dc ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must select Luna for memory"
grep -Fxq "git merge-base --is-ancestor 4558c9fac46ce1a96a25745b477b32b70dab7ae6 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the chat thread draft child-only writer floor"
grep -Fxq "git merge-base --is-ancestor 7a187fa0a3fe2f23a134c7cdff66ee9c7e2bdb38 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the chat thread draft owner key floor"
grep -Fxq "git merge-base --is-ancestor 2222222222222222222222222222222222222222 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the public_brand retirement floor"
grep -Fxq "git merge-base --is-ancestor 3d93ff8d4b4a07a5888e3030e69b340f40da0ad4 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the R2-only chat thread snapshot floor"
grep -Fxq "git merge-base --is-ancestor 3333333333333333333333333333333333333333 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the agent_runs heartbeat column drop floor"
grep -Fxq "git merge-base --is-ancestor 4444444444444444444444444444444444444444 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the personal subscription account-only floor"
grep -Fxq "git merge-base --is-ancestor cdeec36c168636b1a2e510e660eb6139c9c4e07a ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the computer-use audit column cutover floor"
grep -Fxq "git merge-base --is-ancestor 98b5515ae2874128734b19a17b96dc8c6c7afe47 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the chat search GIN maintenance removal floor"
grep -Fxq "git merge-base --is-ancestor ee863a302a6c547f94e50ec4069f70910d68bee2 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the advisory replacement protocol floor"
grep -Fxq "git merge-base --is-ancestor 84ac71914345b8360f3df43cc2cd47f0a8af7a23 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the queued run promotion removal floor"
grep -Fxq "git merge-base --is-ancestor 553fc566b7e9be2cd4a8c1de314d55939b99490a ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the unified chat queue release floor"
grep -Fxq "git merge-base --is-ancestor fd5104417a0cf41116ce9cb9c1aeb2fa3b5e14da ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the runner steer endpoints floor"
grep -Fxq "git merge-base --is-ancestor 45b537a596a153a91b76c3bc7223187840f52775 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the video generation retirement floor"
grep -Fxq "git merge-base --is-ancestor 5555555555555555555555555555555555555555 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the chat thread snapshot JSONB drop floor"
grep -Fxq "git merge-base --is-ancestor 6666666666666666666666666666666666666666 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the Stripe Portal purpose-only floor"
grep -Fxq "git merge-base --is-ancestor 8888888888888888888888888888888888888888 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the retired preference column drop floor"
grep -Fxq "git merge-base --is-ancestor 1212121212121212121212121212121212121212 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the retired integration agent table drop floor"
grep -Fxq "git merge-base --is-ancestor eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the video model column drop floor"
grep -Fxq "git merge-base --is-ancestor 1313131313131313131313131313131313131313 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the image model thread column drop floor"
grep -Fxq "git merge-base --is-ancestor 1515151515151515151515151515151515151515 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the video entitlement column drop floor"
grep -Fxq "git log --reverse --first-parent --diff-filter=A --format=%H origin/main -- turbo/packages/db/src/migrations/1330_drop_retired_model_configuration_columns.sql" "${tmp_dir}/boundaries.log" || fail "retired model configuration floor must resolve the canonical main migration"
grep -Fxq "git merge-base --is-ancestor 1616161616161616161616161616161616161616 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the retired model configuration column drop floor"
grep -Fxq "git log --reverse --first-parent --diff-filter=A --format=%H origin/main -- turbo/packages/db/src/migrations/1332_drop_chat_thread_provider_pin_columns.sql" "${tmp_dir}/boundaries.log" || fail "chat thread provider pin floor must resolve the canonical main migration"
grep -Fxq "git merge-base --is-ancestor 1717171717171717171717171717171717171717 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the chat thread provider pin column drop floor"
grep -Fxq "git log --reverse --first-parent --diff-filter=A --format=%H origin/main -- turbo/packages/db/src/migrations/1333_drop_dead_model_provider_columns.sql" "${tmp_dir}/boundaries.log" || fail "dead model provider column floor must resolve the canonical main migration"
grep -Fxq "git merge-base --is-ancestor 1818181818181818181818181818181818181818 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the dead model provider column drop floor"
grep -Fxq "git log --reverse --first-parent --diff-filter=A --format=%H origin/main -- turbo/packages/db/src/migrations/1334_connector_catalog_release_2_contraction.sql" "${tmp_dir}/boundaries.log" || fail "connector catalog Release 2 floor must resolve the canonical main migration"
grep -Fxq "git merge-base --is-ancestor 1919191919191919191919191919191919191919 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the connector catalog Release 2 floor"
grep -Fxq "git log --reverse --first-parent --diff-filter=A --format=%H origin/main -- turbo/packages/db/src/migrations/1338_retire_model_route_state.sql" "${tmp_dir}/boundaries.log" || fail "model route state floor must resolve the canonical main migration"
grep -Fxq "git merge-base --is-ancestor 3737373737373737373737373737373737373737 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the model route state floor"
grep -Fxq "git log --reverse --first-parent --diff-filter=A --format=%H origin/main -- turbo/packages/db/src/migrations/1343_retire_pi_stable_context.sql" "${tmp_dir}/boundaries.log" || fail "Pi stable-context retirement floor must resolve the canonical main migration"
grep -Fxq "git merge-base --is-ancestor 3838383838383838383838383838383838383838 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the Pi stable-context retirement floor"
grep -Fxq "git log --reverse --first-parent --diff-filter=A --format=%H origin/main -- turbo/packages/db/src/migrations/1356_drop_organization_usage_allowance.sql" "${tmp_dir}/boundaries.log" || fail "Usage Allowance floor must resolve the canonical main migration"
grep -Fxq "git merge-base --is-ancestor 4141414141414141414141414141414141414141 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible API target must pass the Usage Allowance retirement floor"
grep -qx "target_commit=${target_commit}" "$output_file" || fail "missing target commit output"
grep -qx "api_deployment_url=https://api-0.vercel.app" "$output_file" || fail "missing API deployment output"
grep -qx "runner_version=1.2.3" "$output_file" || fail "missing Runner version output"
grep -qx "runner_tag=runner-rs-v1.2.3" "$output_file" || fail "missing retained Runner tag output"
runner_matrix=$(sed -n 's/^runner_matrix=//p' "$output_file")
jq -e 'length == 2 and .[0].id == "arm64" and .[1].id == "x86_64"' >/dev/null <<<"$runner_matrix" || fail "unexpected Runner matrix"

: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates Pi memory Luna routing" \
  run_resolver "${tmp_dir}/pi-memory-luna-floor.output" MOCK_PI_MEMORY_LUNA_ROUTING_FLOOR_VALID=0
grep -Fq '77357abdb29ce96b2caf9ee679299602757844dc' "${tmp_dir}/failure.err" || fail "memory route retirement rejection must identify the Luna routing commit"
[ ! -s "${tmp_dir}/pi-memory-luna-floor.output" ] || fail "DeepSeek-selecting API must not publish rollback outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "DeepSeek-selecting API must fail before artifact or host access"
fi

: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the chat thread draft child-only writer" \
  run_resolver "${tmp_dir}/chat-thread-draft-floor.output" MOCK_CHAT_THREAD_DRAFT_FLOOR_VALID=0
grep -Fq '4558c9fac46ce1a96a25745b477b32b70dab7ae6' "${tmp_dir}/failure.err" || fail "draft contraction rejection must identify the child-only writer commit"
[ ! -s "${tmp_dir}/chat-thread-draft-floor.output" ] || fail "pre-child-writer API target must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "pre-child-writer API target must fail before artifact or host access"
fi

: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the computer-use audit approval column cutover" \
  run_resolver "${tmp_dir}/computer-use-audit-floor.output" MOCK_COMPUTER_USE_AUDIT_FLOOR_VALID=0
grep -Fq 'cdeec36c168636b1a2e510e660eb6139c9c4e07a' "${tmp_dir}/failure.err" || fail "audit column contraction rejection must identify the cutover commit"
[ ! -s "${tmp_dir}/computer-use-audit-floor.output" ] || fail "pre-cutover API target must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "pre-cutover API target must fail before artifact or host access"
fi

: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the chat search GIN maintenance removal" \
  run_resolver "${tmp_dir}/chat-search-gin-floor.output" MOCK_CHAT_SEARCH_GIN_FLOOR_VALID=0
grep -Fq '98b5515ae2874128734b19a17b96dc8c6c7afe47' "${tmp_dir}/failure.err" || fail "pgstattuple drop rejection must identify the maintenance removal commit"
[ ! -s "${tmp_dir}/chat-search-gin-floor.output" ] || fail "pre-removal API target must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "pre-removal API target must fail before artifact or host access"
fi

: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the advisory lock replacement protocols" \
  run_resolver "${tmp_dir}/advisory-lock-preparation-floor.output" MOCK_ADVISORY_LOCK_PREPARATION_FLOOR_VALID=0
grep -Fq 'ee863a302a6c547f94e50ec4069f70910d68bee2' "${tmp_dir}/failure.err" || fail "advisory retirement rejection must identify the preparation commit"
[ ! -s "${tmp_dir}/advisory-lock-preparation-floor.output" ] || fail "pre-preparation API target must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "pre-preparation API target must fail before artifact or host access"
fi

: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the queued run promotion removal" \
  run_resolver "${tmp_dir}/queued-run-promotion-floor.output" MOCK_QUEUED_RUN_PROMOTION_FLOOR_VALID=0
grep -Fq '84ac71914345b8360f3df43cc2cd47f0a8af7a23' "${tmp_dir}/failure.err" || fail "agent_run_queue drop rejection must identify the queued run promotion removal commit"
[ ! -s "${tmp_dir}/queued-run-promotion-floor.output" ] || fail "pre-#37063 API target must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "pre-#37063 API target must fail before artifact or host access"
fi

: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the unified chat queue release" \
  run_resolver "${tmp_dir}/unified-chat-queue-floor.output" MOCK_UNIFIED_CHAT_QUEUE_FLOOR_VALID=0
grep -Fq '553fc566b7e9be2cd4a8c1de314d55939b99490a' "${tmp_dir}/failure.err" || fail "active input delivery drop rejection must identify the release 3 merge commit"
[ ! -s "${tmp_dir}/unified-chat-queue-floor.output" ] || fail "pre-#37082 API target must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "pre-#37082 API target must fail before artifact or host access"
fi

: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the runner steer endpoints" \
  run_resolver "${tmp_dir}/runner-steer-endpoints-floor.output" MOCK_RUNNER_STEER_ENDPOINTS_FLOOR_VALID=0
grep -Fq 'fd5104417a0cf41116ce9cb9c1aeb2fa3b5e14da' "${tmp_dir}/failure.err" || fail "steer endpoint rejection must identify the release 4 merge commit"
[ ! -s "${tmp_dir}/runner-steer-endpoints-floor.output" ] || fail "pre-#37115 API target must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "pre-#37115 API target must fail before artifact or host access"
fi

: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the video generation retirement" \
  run_resolver "${tmp_dir}/video-generation-retirement-floor.output" MOCK_VIDEO_GENERATION_RETIREMENT_FLOOR_VALID=0
grep -Fq '45b537a596a153a91b76c3bc7223187840f52775' "${tmp_dir}/failure.err" || fail "video retirement rejection must identify the #37242 merge commit"
[ ! -s "${tmp_dir}/video-generation-retirement-floor.output" ] || fail "pre-#37242 API target must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "pre-#37242 API target must fail before artifact or host access"
fi

for cutover_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged Stripe Portal purpose-only cutover" \
    run_resolver "${tmp_dir}/stripe-portal-history.output" "MOCK_STRIPE_PORTAL_COMMIT=${cutover_commit}"
  [ ! -s "${tmp_dir}/stripe-portal-history.output" ] || fail "invalid Stripe Portal history must not publish outputs"
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the Stripe Portal purpose-only cutover" \
  run_resolver "${tmp_dir}/stripe-portal-floor.output" MOCK_STRIPE_PORTAL_FLOOR_VALID=0
[ ! -s "${tmp_dir}/stripe-portal-floor.output" ] || fail "pre-cutover API target must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "Stripe Portal cutover floor must fail before artifact or host access"
fi

for retirement_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged Chat Event schema header retirement" \
    run_resolver "${tmp_dir}/chat-event-schema-header-history.output" "MOCK_CHAT_EVENT_SCHEMA_HEADER_COMMIT=${retirement_commit}"
  [ ! -s "${tmp_dir}/chat-event-schema-header-history.output" ] || fail "invalid Chat Event schema header history must not publish outputs"
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the Chat Event schema header retirement" \
  run_resolver "${tmp_dir}/chat-event-schema-header-floor.output" MOCK_CHAT_EVENT_SCHEMA_HEADER_FLOOR_VALID=0
[ ! -s "${tmp_dir}/chat-event-schema-header-floor.output" ] || fail "pre-retirement API target must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "Chat Event schema header floor must fail before artifact or host access"
fi

for drop_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged retired preference column drop" \
    run_resolver "${tmp_dir}/retired-preference-columns-history.output" "MOCK_RETIRED_PREFERENCE_COLUMNS_COMMIT=${drop_commit}"
  [ ! -s "${tmp_dir}/retired-preference-columns-history.output" ] || fail "invalid retired preference column drop history must not publish outputs"
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the retired preference column drop" \
  run_resolver "${tmp_dir}/retired-preference-columns-floor.output" MOCK_RETIRED_PREFERENCE_COLUMNS_FLOOR_VALID=0
[ ! -s "${tmp_dir}/retired-preference-columns-floor.output" ] || fail "pre-drop API target must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "retired preference column drop floor must fail before artifact or host access"
fi

for drop_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged video model column drop" \
    run_resolver "${tmp_dir}/video-model-columns-history.output" "MOCK_VIDEO_MODEL_COLUMNS_COMMIT=${drop_commit}"
  [ ! -s "${tmp_dir}/video-model-columns-history.output" ] || fail "invalid video model column drop history must not publish outputs"
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the video model column drop" \
  run_resolver "${tmp_dir}/video-model-columns-floor.output" MOCK_VIDEO_MODEL_COLUMNS_FLOOR_VALID=0
[ ! -s "${tmp_dir}/video-model-columns-floor.output" ] || fail "pre-drop API target must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "video model column drop floor must fail before artifact or host access"
fi

for drop_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged image model thread column drop" \
    run_resolver "${tmp_dir}/image-model-thread-columns-history.output" "MOCK_IMAGE_MODEL_THREAD_COLUMNS_COMMIT=${drop_commit}"
  [ ! -s "${tmp_dir}/image-model-thread-columns-history.output" ] || fail "invalid image model thread column drop history must not publish outputs"
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the image model thread column drop" \
  run_resolver "${tmp_dir}/image-model-thread-columns-floor.output" MOCK_IMAGE_MODEL_THREAD_COLUMNS_FLOOR_VALID=0
[ ! -s "${tmp_dir}/image-model-thread-columns-floor.output" ] || fail "pre-drop API target must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "image model thread column drop floor must fail before artifact or host access"
fi

# This is the current rollback safety boundary, not retired-feature absence.
for drop_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged video entitlement column drop" \
    run_resolver "${tmp_dir}/video-entitlement-history.output" "MOCK_VIDEO_ENTITLEMENT_COMMIT=${drop_commit}"
  [ ! -s "${tmp_dir}/video-entitlement-history.output" ] || fail "invalid video entitlement history must not publish outputs"
  if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
    fail "invalid video entitlement history must fail before artifact or host access"
  fi
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the video entitlement column drop" \
  run_resolver "${tmp_dir}/video-entitlement-floor.output" MOCK_VIDEO_ENTITLEMENT_FLOOR_VALID=0
grep -Fq '1515151515151515151515151515151515151515' "${tmp_dir}/failure.err" || fail "video entitlement rejection must identify the canonical drop commit"
[ ! -s "${tmp_dir}/video-entitlement-floor.output" ] || fail "incompatible entitlement API must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "video entitlement floor must fail before artifact or host access"
fi

for drop_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged retired model configuration column drop" \
    run_resolver "${tmp_dir}/retired-model-configuration-history.output" "MOCK_RETIRED_MODEL_CONFIGURATION_COMMIT=${drop_commit}"
  [ ! -s "${tmp_dir}/retired-model-configuration-history.output" ] || fail "invalid retired model configuration history must not publish outputs"
  if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
    fail "invalid retired model configuration history must fail before artifact or host access"
  fi
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the retired model configuration column drop" \
  run_resolver "${tmp_dir}/retired-model-configuration-floor.output" MOCK_RETIRED_MODEL_CONFIGURATION_FLOOR_VALID=0
grep -Fq '1616161616161616161616161616161616161616' "${tmp_dir}/failure.err" || fail "retired model configuration rejection must identify the canonical main commit"
[ ! -s "${tmp_dir}/retired-model-configuration-floor.output" ] || fail "pre-drop API must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "retired model configuration floor must fail before artifact or host access"
fi

for drop_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged chat thread provider pin column drop" \
    run_resolver "${tmp_dir}/chat-thread-provider-pin-history.output" "MOCK_CHAT_THREAD_PROVIDER_PIN_COMMIT=${drop_commit}"
  [ ! -s "${tmp_dir}/chat-thread-provider-pin-history.output" ] || fail "invalid chat thread provider pin history must not publish outputs"
  if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
    fail "invalid chat thread provider pin history must fail before artifact or host access"
  fi
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the chat thread provider pin column drop" \
  run_resolver "${tmp_dir}/chat-thread-provider-pin-floor.output" MOCK_CHAT_THREAD_PROVIDER_PIN_FLOOR_VALID=0
grep -Fq '1717171717171717171717171717171717171717' "${tmp_dir}/failure.err" || fail "chat thread provider pin rejection must identify the canonical main commit"
[ ! -s "${tmp_dir}/chat-thread-provider-pin-floor.output" ] || fail "pre-drop API must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "chat thread provider pin floor must fail before artifact or host access"
fi

for drop_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged dead model provider column drop" \
    run_resolver "${tmp_dir}/dead-model-provider-columns-history.output" "MOCK_DEAD_MODEL_PROVIDER_COLUMNS_COMMIT=${drop_commit}"
  [ ! -s "${tmp_dir}/dead-model-provider-columns-history.output" ] || fail "invalid dead model provider column history must not publish outputs"
  if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
    fail "invalid dead model provider column history must fail before artifact or host access"
  fi
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the dead model provider column drop" \
  run_resolver "${tmp_dir}/dead-model-provider-columns-floor.output" MOCK_DEAD_MODEL_PROVIDER_COLUMNS_FLOOR_VALID=0
grep -Fq '1818181818181818181818181818181818181818' "${tmp_dir}/failure.err" || fail "dead model provider column rejection must identify the canonical main commit"
[ ! -s "${tmp_dir}/dead-model-provider-columns-floor.output" ] || fail "pre-drop API must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "dead model provider column floor must fail before artifact or host access"
fi

for drop_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged connector catalog Release 2 contraction" \
    run_resolver "${tmp_dir}/connector-catalog-release-2-history.output" "MOCK_CONNECTOR_CATALOG_RELEASE_2_COMMIT=${drop_commit}"
  [ ! -s "${tmp_dir}/connector-catalog-release-2-history.output" ] || fail "invalid connector catalog Release 2 history must not publish outputs"
  if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
    fail "invalid connector catalog Release 2 history must fail before artifact or host access"
  fi
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the connector catalog Release 2 contraction" \
  run_resolver "${tmp_dir}/connector-catalog-release-2-floor.output" MOCK_CONNECTOR_CATALOG_RELEASE_2_FLOOR_VALID=0
grep -Fq '1919191919191919191919191919191919191919' "${tmp_dir}/failure.err" || fail "connector catalog Release 2 rejection must identify the canonical main commit"
[ ! -s "${tmp_dir}/connector-catalog-release-2-floor.output" ] || fail "pre-Release 2 API must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "connector catalog Release 2 floor must fail before artifact or host access"
fi

for drop_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged model route state retirement" \
    run_resolver "${tmp_dir}/model-route-state-history.output" "MOCK_MODEL_ROUTE_STATE_COMMIT=${drop_commit}"
  [ ! -s "${tmp_dir}/model-route-state-history.output" ] || fail "invalid model route state history must not publish outputs"
  if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
    fail "invalid model route state history must fail before artifact or host access"
  fi
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the model route state retirement" \
  run_resolver "${tmp_dir}/model-route-state-floor.output" MOCK_MODEL_ROUTE_STATE_FLOOR_VALID=0
grep -Fq '3737373737373737373737373737373737373737' "${tmp_dir}/failure.err" || fail "model route state rejection must identify the canonical main commit"
[ ! -s "${tmp_dir}/model-route-state-floor.output" ] || fail "pre-retirement API must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "model route state floor must fail before artifact or host access"
fi

for drop_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged Pi stable-context retirement" \
    run_resolver "${tmp_dir}/pi-stable-context-history.output" "MOCK_PI_STABLE_CONTEXT_COMMIT=${drop_commit}"
  [ ! -s "${tmp_dir}/pi-stable-context-history.output" ] || fail "invalid Pi stable-context retirement history must not publish outputs"
  if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
    fail "invalid Pi stable-context retirement history must fail before artifact or host access"
  fi
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the Pi stable-context retirement" \
  run_resolver "${tmp_dir}/pi-stable-context-floor.output" MOCK_PI_STABLE_CONTEXT_FLOOR_VALID=0
grep -Fq '3838383838383838383838383838383838383838' "${tmp_dir}/failure.err" || fail "Pi stable-context retirement rejection must identify the canonical main commit"
[ ! -s "${tmp_dir}/pi-stable-context-floor.output" ] || fail "pre-retirement API must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "Pi stable-context retirement floor must fail before artifact or host access"
fi

for preparation_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged connector catalog payload-independent API" \
    run_resolver "${tmp_dir}/connector-catalog-payload-independent-history.output" "MOCK_CONNECTOR_CATALOG_PAYLOAD_INDEPENDENT_COMMIT=${preparation_commit}"
  [ ! -s "${tmp_dir}/connector-catalog-payload-independent-history.output" ] || fail "invalid catalog preparation history must not publish outputs"
  if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
    fail "invalid catalog preparation history must fail before artifact or host access"
  fi
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the connector catalog payload-independent API" \
  run_resolver "${tmp_dir}/connector-catalog-payload-independent-floor.output" MOCK_CONNECTOR_CATALOG_PAYLOAD_INDEPENDENT_FLOOR_VALID=0
grep -Fq '4040404040404040404040404040404040404040' "${tmp_dir}/failure.err" || fail "catalog preparation rejection must identify the canonical main commit"
[ ! -s "${tmp_dir}/connector-catalog-payload-independent-floor.output" ] || fail "payload-dependent API must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "catalog preparation floor must fail before artifact or host access"
fi

for drop_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged Pi debug trace retirement" \
    run_resolver "${tmp_dir}/pi-debug-trace-history.output" "MOCK_PI_DEBUG_TRACE_COMMIT=${drop_commit}"
  [ ! -s "${tmp_dir}/pi-debug-trace-history.output" ] || fail "invalid Pi debug trace retirement history must not publish outputs"
  if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
    fail "invalid Pi debug trace retirement history must fail before artifact or host access"
  fi
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the Pi debug trace retirement" \
  run_resolver "${tmp_dir}/pi-debug-trace-floor.output" MOCK_PI_DEBUG_TRACE_FLOOR_VALID=0
grep -Fq '3939393939393939393939393939393939393939' "${tmp_dir}/failure.err" || fail "Pi debug trace rejection must identify the canonical main commit"
[ ! -s "${tmp_dir}/pi-debug-trace-floor.output" ] || fail "pre-retirement API must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "Pi debug trace floor must fail before artifact or host access"
fi

for drop_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged Usage Allowance retirement" \
    run_resolver "${tmp_dir}/usage-allowance-history.output" "MOCK_USAGE_ALLOWANCE_COMMIT=${drop_commit}"
  [ ! -s "${tmp_dir}/usage-allowance-history.output" ] || fail "invalid Usage Allowance retirement history must not publish outputs"
  if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
    fail "invalid Usage Allowance retirement history must fail before artifact or host access"
  fi
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the Usage Allowance retirement" \
  run_resolver "${tmp_dir}/usage-allowance-floor.output" MOCK_USAGE_ALLOWANCE_FLOOR_VALID=0
grep -Fq '4141414141414141414141414141414141414141' "${tmp_dir}/failure.err" || fail "Usage Allowance rejection must identify the canonical main commit"
[ ! -s "${tmp_dir}/usage-allowance-floor.output" ] || fail "pre-Allowance-retirement API must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "Usage Allowance floor must fail before artifact or host access"
fi

for v8_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged Chat Event V8 migration" \
    run_resolver "${tmp_dir}/chat-event-v8-history.output" "MOCK_CHAT_EVENT_V8_COMMIT=${v8_commit}"
  [ ! -s "${tmp_dir}/chat-event-v8-history.output" ] || fail "invalid Chat Event V8 history must not publish outputs"
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the Chat Event V8 migration" \
  run_resolver "${tmp_dir}/chat-event-v8-floor.output" MOCK_CHAT_EVENT_V8_FLOOR_VALID=0
[ ! -s "${tmp_dir}/chat-event-v8-floor.output" ] || fail "pre-V8 API target must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "Chat Event V8 floor must fail before artifact or host access"
fi

for preparation_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged checkpoint writer preparation" \
    run_resolver "${tmp_dir}/checkpoint-writer-history.output" "MOCK_CHECKPOINT_WRITER_PREPARATION_COMMIT=${preparation_commit}"
  [ ! -s "${tmp_dir}/checkpoint-writer-history.output" ] || fail "invalid checkpoint preparation history must not publish outputs"
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates checkpoint writer preparation" \
  run_resolver "${tmp_dir}/checkpoint-writer-floor.output" MOCK_CHECKPOINT_WRITER_PREPARATION_FLOOR_VALID=0
[ ! -s "${tmp_dir}/checkpoint-writer-floor.output" ] || fail "unprepared checkpoint writer must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "checkpoint writer floor must fail before artifact or host access"
fi

for mutation_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged Browser session mutation contract" \
    run_resolver "${tmp_dir}/browser-session-mutations-history.output" "MOCK_BROWSER_SESSION_MUTATIONS_COMMIT=${mutation_commit}"
  [ ! -s "${tmp_dir}/browser-session-mutations-history.output" ] || fail "invalid Browser mutation history must not publish outputs"
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the Browser session mutation contract" \
  run_resolver "${tmp_dir}/browser-session-mutations-floor.output" MOCK_BROWSER_SESSION_MUTATIONS_FLOOR_VALID=0
[ ! -s "${tmp_dir}/browser-session-mutations-floor.output" ] || fail "incompatible Browser mutation API must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "Browser mutation floor must fail before artifact or host access"
fi

for drop_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged retired integration agent table drop" \
    run_resolver "${tmp_dir}/retired-integration-agent-tables-history.output" "MOCK_RETIRED_INTEGRATION_AGENT_TABLES_COMMIT=${drop_commit}"
  [ ! -s "${tmp_dir}/retired-integration-agent-tables-history.output" ] || fail "invalid retired integration agent table drop history must not publish outputs"
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the retired integration agent table drop" \
  run_resolver "${tmp_dir}/retired-integration-agent-tables-floor.output" MOCK_RETIRED_INTEGRATION_AGENT_TABLES_FLOOR_VALID=0
[ ! -s "${tmp_dir}/retired-integration-agent-tables-floor.output" ] || fail "pre-drop API target must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "retired integration agent table drop floor must fail before artifact or host access"
fi

for retirement_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged public_brand retirement" \
    run_resolver "${tmp_dir}/public-brand-history.output" "MOCK_PUBLIC_BRAND_RETIREMENT_COMMIT=${retirement_commit}"
  [ ! -s "${tmp_dir}/public-brand-history.output" ] || fail "invalid public_brand history must not publish outputs"
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the public_brand retirement" \
  run_resolver "${tmp_dir}/public-brand-floor.output" MOCK_PUBLIC_BRAND_RETIREMENT_FLOOR_VALID=0
[ ! -s "${tmp_dir}/public-brand-floor.output" ] || fail "pre-retirement API target must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "public_brand retirement floor must fail before artifact or host access"
fi

for drop_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged agent_runs heartbeat column drop" \
    run_resolver "${tmp_dir}/agent-run-heartbeat-history.output" "MOCK_AGENT_RUN_HEARTBEAT_DROP_COMMIT=${drop_commit}"
  [ ! -s "${tmp_dir}/agent-run-heartbeat-history.output" ] || fail "invalid agent_runs heartbeat drop history must not publish outputs"
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the agent_runs heartbeat column drop" \
  run_resolver "${tmp_dir}/agent-run-heartbeat-floor.output" MOCK_AGENT_RUN_HEARTBEAT_DROP_FLOOR_VALID=0
[ ! -s "${tmp_dir}/agent-run-heartbeat-floor.output" ] || fail "pre-drop API target must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "agent_runs heartbeat column drop floor must fail before artifact or host access"
fi

for account_only_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged personal subscription account-only migration" \
    run_resolver "${tmp_dir}/personal-subscription-history.output" "MOCK_PERSONAL_SUBSCRIPTION_COMMIT=${account_only_commit}"
  [ ! -s "${tmp_dir}/personal-subscription-history.output" ] || fail "invalid personal subscription history must not publish outputs"
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the personal subscription account-only store" \
  run_resolver "${tmp_dir}/personal-subscription-floor.output" MOCK_PERSONAL_SUBSCRIPTION_FLOOR_VALID=0
[ ! -s "${tmp_dir}/personal-subscription-floor.output" ] || fail "pre-account-only API target must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "personal subscription account-only floor must fail before artifact or host access"
fi

: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the R2-only chat thread snapshot API" \
  run_resolver "${tmp_dir}/snapshot-r2-only-floor.output" MOCK_CHAT_THREAD_SNAPSHOT_R2_ONLY_FLOOR_VALID=0
grep -Fq '3d93ff8d4b4a07a5888e3030e69b340f40da0ad4' "${tmp_dir}/failure.err" || fail "R2-only rejection must identify the #36945 merge commit"
[ ! -s "${tmp_dir}/snapshot-r2-only-floor.output" ] || fail "pre-R2-only API target must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "R2-only floor must fail before artifact or host access"
fi

for drop_commit in "" invalid; do
  : >"${tmp_dir}/boundaries.log"
  assert_failure "Cannot resolve the merged chat thread snapshot JSONB drop" \
    run_resolver "${tmp_dir}/snapshot-jsonb-history.output" "MOCK_SNAPSHOT_JSONB_DROP_COMMIT=${drop_commit}"
  [ ! -s "${tmp_dir}/snapshot-jsonb-history.output" ] || fail "invalid snapshot JSONB drop history must not publish outputs"
done
: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the chat thread snapshot JSONB drop" \
  run_resolver "${tmp_dir}/snapshot-jsonb-floor.output" MOCK_SNAPSHOT_JSONB_DROP_FLOOR_VALID=0
[ ! -s "${tmp_dir}/snapshot-jsonb-floor.output" ] || fail "pre-drop API target must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "snapshot JSONB drop floor must fail before artifact or host access"
fi

: >"${tmp_dir}/boundaries.log"
assert_failure "Rollback target predates the chat thread draft owner key writer" \
  run_resolver "${tmp_dir}/chat-thread-draft-owner-key-floor.output" MOCK_CHAT_THREAD_DRAFT_OWNER_KEY_FLOOR_VALID=0
grep -Fq '7a187fa0a3fe2f23a134c7cdff66ee9c7e2bdb38' "${tmp_dir}/failure.err" || fail "draft owner key rejection must identify the owner key commit"
[ ! -s "${tmp_dir}/chat-thread-draft-owner-key-floor.output" ] || fail "pre-owner-key API target must not publish outputs"
if grep -Eq '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "pre-owner-key API target must fail before artifact or host access"
fi

: >"${tmp_dir}/boundaries.log"
assert_failure "predates structured provider balance failures" \
  run_resolver "${tmp_dir}/balance-runner.output" MOCK_BALANCE_RUNNER_FLOOR_VALID=0
[ ! -s "${tmp_dir}/balance-runner.output" ] || fail "incompatible retained Runner must not publish outputs"
if grep -Eq '^ssh |api.github.com/repos/.*/releases/tags/' "${tmp_dir}/boundaries.log"; then
  fail "incompatible retained Runner must fail before Runner artifact or host access"
fi

: >"${tmp_dir}/boundaries.log"
assert_failure "found 0" run_resolver "${tmp_dir}/zero.output" MOCK_VERCEL_MATCH_COUNT=0
[ ! -s "${tmp_dir}/zero.output" ] || fail "failed resolution must not publish outputs"

: >"${tmp_dir}/boundaries.log"
assert_failure "found 2" run_resolver "${tmp_dir}/multiple.output" MOCK_VERCEL_MATCH_COUNT=2
[ ! -s "${tmp_dir}/multiple.output" ] || fail "ambiguous API resolution must not publish outputs"

: >"${tmp_dir}/boundaries.log"
assert_failure "is missing runner-v1.2.3-x86_64-linux" run_resolver "${tmp_dir}/missing-runner.output" MOCK_RUNNER_ASSETS_VALID=0
[ ! -s "${tmp_dir}/missing-runner.output" ] || fail "missing Runner asset must not publish outputs"

invalid_commit=not-a-full-sha
target_commit_before=$target_commit
target_commit=$invalid_commit
: >"${tmp_dir}/boundaries.log"
assert_failure "must be a full lowercase SHA-1" run_resolver "${tmp_dir}/invalid.output"
target_commit=$target_commit_before
[ ! -s "${tmp_dir}/boundaries.log" ] || fail "invalid target must fail before external boundaries"

: >"${tmp_dir}/boundaries.log"
assert_failure "Runner release runner-rs-v1.2.3 predates the blank sandbox status reader" \
  run_resolver "${tmp_dir}/blank-runner-floor.output" MOCK_BLANK_RUNNER_FLOOR_VALID=0
[ ! -s "${tmp_dir}/blank-runner-floor.output" ] || fail "old Runner artifact must not publish outputs"
if grep -q 'api.github.com/repos/.*/releases/tags/' "${tmp_dir}/boundaries.log"; then
  fail "blank reader artifact rejection must precede asset resolution"
fi

release_target_script="${tmp_dir}/resolve-release-target.sh"
ruby -e '
  require "json"
  require "yaml"
  workflow = YAML.safe_load(File.read(ARGV[0]), aliases: true)
  release_job = workflow.fetch("jobs").fetch("release-please")
  release_target_step = release_job.fetch("steps").find { |step| step["id"] == "release-target" }
  raise "missing release target resolver step" unless release_target_step

  resolver_env = release_target_step.fetch("env")
  unless resolver_env.keys == ["RELEASE_SHAS"]
    raise "release target resolver environment must contain only RELEASE_SHAS"
  end

  projection = resolver_env.fetch("RELEASE_SHAS")
  projected_paths = projection.scan(/steps\.release\.outputs\[\x27([^\x27]+)--sha\x27\]/).flatten
  output_reference_count = projection.scan(/steps\.release\.outputs/).length
  unless output_reference_count == projected_paths.length
    raise "release bodies, changelogs, and complete outputs must not enter the release target resolver environment"
  end

  configured_paths = JSON.parse(File.read(ARGV[1])).fetch("packages").keys
  missing_paths = configured_paths - projected_paths
  unknown_paths = projected_paths - configured_paths
  duplicate_paths = projected_paths.group_by(&:itself).select { |_, paths| paths.length > 1 }.keys
  unless missing_paths.empty? && unknown_paths.empty? && duplicate_paths.empty?
    raise "release SHA projection mismatch: missing=#{missing_paths.sort}, unknown=#{unknown_paths.sort}, duplicates=#{duplicate_paths.sort}"
  end

  puts release_target_step.fetch("run")
' \
  "${repo_root}/.github/workflows/release-please.yml" \
  "${repo_root}/release-please-config.json" \
  >"$release_target_script"

release_target=cccccccccccccccccccccccccccccccccccccccc
release_target_output="${tmp_dir}/release-target.output"
RELEASE_SHAS="$(jq -nc --arg target "$release_target" '[null, "", $target, null]')" \
  GITHUB_OUTPUT="$release_target_output" \
  bash "$release_target_script"
grep -qx "sha=${release_target}" "$release_target_output" || fail "release target resolver did not publish the unique release SHA"

missing_release_target_output="${tmp_dir}/missing-release-target.output"
assert_failure \
  "release-please returned no release SHA" \
  env \
  RELEASE_SHAS='["", ""]' \
  GITHUB_OUTPUT="$missing_release_target_output" \
  bash "$release_target_script"
[ ! -s "$missing_release_target_output" ] || fail "missing release SHA must not publish an output"

invalid_release_target_output="${tmp_dir}/invalid-release-target.output"
assert_failure \
  "release-please returned invalid release SHA" \
  env \
  RELEASE_SHAS='["cccccccccccccccccccccccccccccccccccccccc", "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"]' \
  GITHUB_OUTPUT="$invalid_release_target_output" \
  bash "$release_target_script"
[ ! -s "$invalid_release_target_output" ] || fail "invalid release SHA must not publish an output"

multiple_release_targets=$(jq -nc '[
  "cccccccccccccccccccccccccccccccccccccccc",
  "dddddddddddddddddddddddddddddddddddddddd"
]')
multiple_release_target_output="${tmp_dir}/multiple-release-target.output"
assert_failure \
  "release-please returned multiple release SHAs" \
  env \
  RELEASE_SHAS="$multiple_release_targets" \
  GITHUB_OUTPUT="$multiple_release_target_output" \
  bash "$release_target_script"
[ ! -s "$multiple_release_target_output" ] || fail "ambiguous release SHAs must not publish an output"

release_tags_script="${tmp_dir}/resolve-release-tags.sh"
ruby -e '
  require "json"
  require "yaml"
  workflow = YAML.safe_load(File.read(ARGV[0]), aliases: true)
  release_job = workflow.fetch("jobs").fetch("release-please")
  release_tags_step = release_job.fetch("steps").find { |step| step["id"] == "release-tags" }
  raise "missing current release tag resolver step" unless release_tags_step

  resolver_env = release_tags_step.fetch("env")
  unless resolver_env.keys == ["RELEASE_TAGS", "DESKTOP_RELEASE_CREATED", "DESKTOP_VERSION"]
    raise "release tag resolver environment has unexpected inputs"
  end

  projection = resolver_env.fetch("RELEASE_TAGS")
  projected_paths = projection.scan(/steps\.release\.outputs\[\x27([^\x27]+)--tag_name\x27\]/).flatten
  output_reference_count = projection.scan(/steps\.release\.outputs/).length
  unless output_reference_count == projected_paths.length
    raise "release bodies, changelogs, and complete outputs must not enter the release tag resolver environment"
  end

  configured_paths = JSON.parse(File.read(ARGV[1])).fetch("packages").keys
  missing_paths = configured_paths - projected_paths
  unknown_paths = projected_paths - configured_paths
  duplicate_paths = projected_paths.group_by(&:itself).select { |_, paths| paths.length > 1 }.keys
  unless missing_paths.empty? && unknown_paths.empty? && duplicate_paths.empty?
    raise "release tag projection mismatch: missing=#{missing_paths.sort}, unknown=#{unknown_paths.sort}, duplicates=#{duplicate_paths.sort}"
  end

  desktop_release_created = "$" + "{{ steps.release.outputs[\x27desktop--release_created\x27] }}"
  desktop_version = "$" + "{{ steps.release.outputs[\x27desktop--version\x27] }}"
  unless resolver_env.fetch("DESKTOP_RELEASE_CREATED") == desktop_release_created &&
      resolver_env.fetch("DESKTOP_VERSION") == desktop_version
    raise "release tag resolver must derive the Okou Desktop tag from the Desktop release outputs"
  end

  puts release_tags_step.fetch("run")
' \
  "${repo_root}/.github/workflows/release-please.yml" \
  "${repo_root}/release-please-config.json" \
  >"$release_tags_script"

release_tags_output="${tmp_dir}/release-tags.output"
RELEASE_TAGS='[null,"","api-v1.2.3","app-v4.5.6"]' \
  DESKTOP_RELEASE_CREATED='' \
  DESKTOP_VERSION='' \
  GITHUB_OUTPUT="$release_tags_output" \
  bash "$release_tags_script"
grep -Fqx 'tags=["api-v1.2.3","app-v4.5.6"]' "$release_tags_output" || \
  fail "release tag resolver did not publish the current release tags"

desktop_release_tags_output="${tmp_dir}/desktop-release-tags.output"
RELEASE_TAGS='["desktop-v4.5.6"]' \
  DESKTOP_RELEASE_CREATED=true \
  DESKTOP_VERSION=4.5.6 \
  GITHUB_OUTPUT="$desktop_release_tags_output" \
  bash "$release_tags_script"
grep -Fqx 'tags=["desktop-v4.5.6","okou-desktop-v4.5.6"]' "$desktop_release_tags_output" || \
  fail "release tag resolver did not publish the derived Okou Desktop tag"

missing_release_tags_output="${tmp_dir}/missing-release-tags.output"
assert_failure \
  "release-please returned no release tag" \
  env \
  RELEASE_TAGS='[null,""]' \
  DESKTOP_RELEASE_CREATED='' \
  DESKTOP_VERSION='' \
  GITHUB_OUTPUT="$missing_release_tags_output" \
  bash "$release_tags_script"
[ ! -s "$missing_release_tags_output" ] || fail "missing release tags must not publish an output"

non_string_release_tags_output="${tmp_dir}/non-string-release-tags.output"
assert_failure \
  "release-please returned non-string release tag" \
  env \
  RELEASE_TAGS='["api-v1.2.3",123]' \
  DESKTOP_RELEASE_CREATED='' \
  DESKTOP_VERSION='' \
  GITHUB_OUTPUT="$non_string_release_tags_output" \
  bash "$release_tags_script"
[ ! -s "$non_string_release_tags_output" ] || fail "non-string release tags must not publish an output"

invalid_release_tags_output="${tmp_dir}/invalid-release-tags.output"
assert_failure \
  "release-please returned invalid release tag" \
  env \
  RELEASE_TAGS='["not-a-version-tag"]' \
  DESKTOP_RELEASE_CREATED='' \
  DESKTOP_VERSION='' \
  GITHUB_OUTPUT="$invalid_release_tags_output" \
  bash "$release_tags_script"
[ ! -s "$invalid_release_tags_output" ] || fail "invalid release tags must not publish an output"

duplicate_release_tags_output="${tmp_dir}/duplicate-release-tags.output"
assert_failure \
  "release-please returned duplicate release tags: api-v1.2.3" \
  env \
  RELEASE_TAGS='["api-v1.2.3","api-v1.2.3"]' \
  DESKTOP_RELEASE_CREATED='' \
  DESKTOP_VERSION='' \
  GITHUB_OUTPUT="$duplicate_release_tags_output" \
  bash "$release_tags_script"
[ ! -s "$duplicate_release_tags_output" ] || fail "duplicate release tags must not publish an output"

ruby - \
  "${repo_root}/.github/workflows/rollback-production.yml" \
  "${repo_root}/.github/workflows/release-please.yml" \
  "${repo_root}/.github/workflows/turbo.yml" <<'RUBY'
  require "yaml"
  rollback_config = YAML.safe_load(File.read(ARGV[0]), aliases: true)
  release_config = YAML.safe_load(File.read(ARGV[1]), aliases: true)
  turbo_config = YAML.safe_load(File.read(ARGV[2]), aliases: true)
  raise "rollback must not use lossy GitHub concurrency" if rollback_config.key?("concurrency")
  raise "release must not use lossy GitHub concurrency" if release_config.key?("concurrency")
  rollback = rollback_config.fetch("jobs")
  release = release_config.fetch("jobs")
  turbo = turbo_config.fetch("jobs")
  canonical_api_backend_source = "$" + "{{ vars.OKOU_API_BACKEND_URL }}"
  release_api_step = release.fetch("promote-api-production").fetch("steps").find do |step|
    step["name"] == "Resolve API production environment"
  end
  raise "missing release API production environment step" unless release_api_step
  release_runner_step = release.fetch("build-runner-production").fetch("steps").find do |step|
    step["name"] == "Build rootfs and snapshot on production hosts"
  end
  raise "missing release Runner build step" unless release_runner_step
  rollback_runner_step = rollback.fetch("rollback-runner").fetch("steps").find do |step|
    step["name"] == "Roll back Runner on production hosts"
  end
  raise "missing production Runner rollback step" unless rollback_runner_step

  selected_api_backend_sources = [
    release_api_step.fetch("with").fetch("api-backend-url"),
    release_runner_step.fetch("env").fetch("API_URL"),
    rollback_runner_step.fetch("env").fetch("API_URL"),
  ]
  unless selected_api_backend_sources == Array.new(3, canonical_api_backend_source)
    raise "production API backend sources must use only the canonical GitHub variable"
  end

  neutral_api_url = "$" + "{API_URL}"
  {
    "release Runner build" => release_runner_step,
    "production Runner rollback" => rollback_runner_step,
  }.each do |boundary, step|
    env = step.fetch("env")
    if env.key?("OKOU_API_BACKEND_URL")
      raise "#{boundary} must retain the neutral API_URL shell boundary"
    end
    unless step.fetch("run").include?("-e \"api_url=#{neutral_api_url}\"")
      raise "#{boundary} must retain the neutral Ansible api_url input"
    end
  end
  raise "rollback resolver must wait for queue" unless rollback.fetch("resolve-target").fetch("needs") == "queue-production-deploy"
  raise "Runner must wait for resolver" unless rollback.fetch("rollback-runner").fetch("needs") == "resolve-target"
  raise "API must wait for resolver" unless rollback.fetch("rollback-api").fetch("needs") == "resolve-target"
  release_job = release.fetch("release-please")
  release_needs = Array(release_job.fetch("needs"))
  raise "release must wait for production queue" unless release_needs.include?("queue-production-deploy")
  raise "release must wait for release detection" unless release_needs.include?("detect-release-commit")
  queue_needs = Array(release.fetch("queue-production-deploy").fetch("needs"))
  raise "production queue must wait for release detection" unless queue_needs.include?("detect-release-commit")
  release_target_output = "$" + "{{ steps.release-target.outputs.sha }}"
  raise "release job must expose the resolved release target" unless release_job.fetch("outputs").fetch("release_target") == release_target_output
  release_tags_output = "$" + "{{ steps.release-tags.outputs.tags }}"
  raise "release job must expose the current release tags" unless release_job.fetch("outputs").fetch("release_tags") == release_tags_output
  raise "release workflow must not use the triggering workflow SHA as a release target" if File.read(ARGV[1]).include?("github.event.workflow_run.head_sha")

  expected_target = "$" + "{{ needs.release-please.outputs.release_target }}"
  expected_tags = "$" + "{{ needs.release-please.outputs.release_tags }}"
  workflow_source = "$" + "{{ github.sha }}"
  checkout_ref_exceptions = {
    "queue-production-deploy" => "main",
    "refresh-release-pull-request" => "main",
    "update-rollback-dashboard" => workflow_source,
  }
  release.each do |job_name, job|
    checkout_steps = job.fetch("steps", []).select do |step|
      step["uses"].to_s.start_with?("actions/checkout@")
    end
    checkout_steps.each do |checkout_step|
      expected_ref = checkout_ref_exceptions.fetch(job_name, expected_target)
      actual_ref = checkout_step.fetch("with", {})["ref"]
      unless actual_ref == expected_ref
        raise "#{job_name} checkout must use #{expected_ref.inspect}, got #{actual_ref.inspect}"
      end
    end
  end

  host_worker_step = release.fetch("detect-host-worker-deploy-inputs").fetch("steps").find { |step| step["id"] == "detect" }
  raise "Host Worker detection must use the resolved release target" unless host_worker_step.fetch("run").include?("HEAD_SHA=\"#{expected_target}\"")
  schema_step = release.fetch("deploy-api-schema").fetch("steps").find { |step| step["name"] == "Publish Runtime API Schema" }
  raise "Runtime API Schema must use the resolved release target" unless schema_step.fetch("env").fetch("RELEASE_SHA") == expected_target
  dashboard_step = release.fetch("update-rollback-dashboard").fetch("steps").find { |step| step["name"] == "Update rollback dashboard issue" }
  dashboard_job = release.fetch("update-rollback-dashboard")
  dashboard_needs = Array(dashboard_job.fetch("needs"))
  raise "rollback dashboard must wait for Desktop promotion" unless dashboard_needs.include?("promote-desktop-release")
  dashboard_condition = dashboard_job.fetch("if")
  unless dashboard_condition.include?("needs.release-please.outputs.desktop_release_created != \x27true\x27") &&
      dashboard_condition.include?("needs.promote-desktop-release.result == \x27success\x27")
    raise "rollback dashboard must require successful applicable Desktop promotion"
  end
  raise "rollback dashboard must use the resolved release target" unless dashboard_step.fetch("env").fetch("RELEASE_TARGET") == expected_target
  raise "rollback dashboard must use the current release tags" unless dashboard_step.fetch("env").fetch("RELEASE_TAGS") == expected_tags
  raise "rollback dashboard must pass the current release tags to the helper" unless dashboard_step.fetch("run").include?("\"$RELEASE_TAGS\"")

  artifact_fetch_helper = "fetch-okou-app-artifact.sh"
  release_app_step = release.fetch("promote-app-worker-production").fetch("steps").find { |step| step["id"] == "worker-production" }
  release_app_run = release_app_step.fetch("run")
  raise "release App deployment must use the shared artifact fetcher" unless release_app_run.include?(artifact_fetch_helper)
  raise "release App deployment must not fall back to per-file artifacts" if release_app_run.include?("--recursive")

  artifact_upload_step = turbo.fetch("deploy-app").fetch("steps").find { |step| step["name"] == "Upload canonical app artifact" }
  artifact_upload_run = artifact_upload_step.fetch("run")
  raise "deploy-app must upload the archived App artifact" unless artifact_upload_run.include?("/dist.tar.gz")
  raise "deploy-app must not upload per-file App artifacts" if artifact_upload_run.include?("aws s3 cp turbo/apps/platform/dist")
RUBY

echo "resolve-production-rollback-target tests passed"
