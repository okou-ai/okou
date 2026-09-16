#!/usr/bin/env bats

# Deployed built-in fallback completion after a trusted exact-route cooldown.

load '../../helpers/setup'
load '../../helpers/runner-chat'
load '../../helpers/runner-api'

BATS_TEST_TIMEOUT=600
BUILT_IN_FALLBACK_MODEL="gpt-5.6-luna"

setup() {
    local credentials="/tmp/e2e-api-credentials-runner-real-codex-built-in.json"
    export E2E_API_TOKEN E2E_API_URL
    E2E_API_TOKEN="$(jq -er '.token | select(type == "string" and length > 0)' "$credentials")"
    E2E_API_URL="$(jq -er '.apiUrl | select(type == "string" and length > 0)' "$credentials")"
    runner_e2e_require_environment
    : "${OKOU_MITM_RUNNER_TOKEN:?built-in fallback E2E requires trusted failure authentication}"
    runner_e2e_setup_test

    local feature_switches
    feature_switches="$(runner_api_curl "/api/feature-switches")"
    jq -e '
        .effectiveSwitches._realAgentInPreview == true
    ' <<<"$feature_switches" >/dev/null
}

teardown() {
    runner_e2e_teardown_test
}

report_built_in_model_failure() {
    local run_id="$1"
    local base_url token
    local -a headers
    base_url="$(runner_api_url)" || return
    token="${OKOU_MITM_RUNNER_TOKEN:?built-in fallback E2E requires trusted failure authentication}"
    headers=(
        -H "Authorization: Bearer $token"
        -H "Content-Type: application/json"
    )
    if [[ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]]; then
        headers+=(
            -H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET"
        )
    fi

    curl --fail-with-body --silent --show-error \
        --connect-timeout "${E2E_CURL_CONNECT_TIMEOUT_SECONDS:-10}" \
        --max-time "${E2E_CURL_MAX_TIME_SECONDS:-30}" \
        "${headers[@]}" \
        -X POST \
        -d '{"failureKind":"rate_limit","retryAfterSeconds":30}' \
        "${base_url}/api/runners/runs/${run_id}/model-provider-failures"
}

@test "a later built-in model run completes through the OpenRouter fallback" {
    run create_runner_agent "e2e-built-in-fallback-${TEST_ID}"
    assert_success
    AGENT_ID="$output"

    run set_runner_agent_instructions \
        "$AGENT_ID" \
        "Built-in model fallback completion test instructions."
    assert_success

    run runner_api_curl "/api/model-policies"
    assert_success
    run jq -e --arg model "$BUILT_IN_FALLBACK_MODEL" '
        any(.policies[]?;
            .model == $model and
            .defaultProviderType == "built-in" and
            .credentialScope == "org" and
            .modelProviderId == null
        )
    ' <<<"$output"
    assert_success

    local nonce primary_expected primary_context
    nonce="$(_runner_uuid)"
    primary_expected="RESULT=primary-${nonce%%-*}"
    run runner_chat_send \
        "$AGENT_ID" \
        "Reply only ${primary_expected}" \
        "" \
        "$BUILT_IN_FALLBACK_MODEL"
    assert_success
    RUN_ID="$(jq -er '.runId | select(type == "string" and length > 0)' <<<"$output")"
    THREAD_ID="$(jq -er '.threadId | select(type == "string" and length > 0)' <<<"$output")"

    run runner_wait_for_run "$RUN_ID" 180
    assert_success
    run _wait_for_runner_chat_output \
        "$THREAD_ID" \
        "$RUN_ID" \
        "$primary_expected" \
        60
    assert_success

    run runner_api_curl "/api/runs/${RUN_ID}/context"
    assert_success
    primary_context="$output"
    run jq -e --arg model "$BUILT_IN_FALLBACK_MODEL" '
        .cliAgentType == "codex" and
        .environment.OPENAI_MODEL == $model and
        (.environment | has("OPENAI_BASE_URL") | not) and
        any(.firewalls[]?;
            .kind == "builtin" and
            .name == "model-provider:openai-api-key"
        )
    ' <<<"$primary_context"
    assert_success

    run report_built_in_model_failure "$RUN_ID"
    assert_success
    run jq -e '. == {"outcome":"recorded"}' <<<"$output"
    assert_success

    local fallback_expected fallback_result fallback_run_id
    local fallback_context
    fallback_expected="RESULT=fallback-${nonce%%-*}"
    run runner_chat_send_after_completion \
        "$AGENT_ID" \
        "$THREAD_ID" \
        "$RUN_ID" \
        "Reply only ${fallback_expected}" \
        "$fallback_expected" \
        180
    assert_success
    fallback_result="$output"
    fallback_run_id="$(runner_chat_field "$fallback_result" '.runId')"
    RUN_ID="$fallback_run_id"

    run runner_api_curl "/api/runs/${fallback_run_id}/context"
    assert_success
    fallback_context="$output"
    run jq -e --arg model "openai/${BUILT_IN_FALLBACK_MODEL}" '
        .cliAgentType == "codex" and
        .environment.OPENAI_BASE_URL == "https://openrouter.ai/api/v1" and
        .environment.OPENAI_MODEL == $model and
        any(.firewalls[]?;
            .kind == "builtin" and
            .name == "model-provider:openrouter-codex"
        )
    ' <<<"$fallback_context"
    assert_success
}
