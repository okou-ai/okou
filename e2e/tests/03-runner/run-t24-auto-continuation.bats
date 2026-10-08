#!/usr/bin/env bats

# Auto continues on its canonical OpenRouter route without vendor fallback
# injection or trusted runner-only credentials.

load '../../helpers/setup'
load '../../helpers/runner-chat'
load '../../helpers/runner-api'

BATS_TEST_TIMEOUT=600

setup() {
    local credentials="/tmp/e2e-api-credentials-runner-real-codex-built-in.json"
    export E2E_API_TOKEN E2E_API_URL
    E2E_API_TOKEN="$(jq -er '.token | select(type == "string" and length > 0)' "$credentials")"
    E2E_API_URL="$(jq -er '.apiUrl | select(type == "string" and length > 0)' "$credentials")"
    runner_e2e_require_environment
    runner_e2e_setup_test
}

teardown() {
    runner_e2e_teardown_test
}

assert_auto_context() {
    runner_api_curl "/api/runs/$1/context" | jq -e '
        .cliAgentType == "pi" and
        .environment.OPENAI_BASE_URL == "https://openrouter.ai/api/v1" and
        .environment.OPENAI_MODEL == "@preset/okou-1-0" and
        any(.firewalls[]?;
            .kind == "builtin" and .name == "model-provider:openrouter-codex"
        )
    '
}

@test "auto preserves session continuity and its OpenRouter route on a successor" {
    run create_runner_agent "e2e-auto-continuation-${TEST_ID}"
    assert_success
    AGENT_ID="$output"
    run set_runner_agent_instructions "$AGENT_ID" "Auto continuation test instructions."
    assert_success

    local nonce expected first_session successor_result successor_run_id
    nonce="$(_runner_uuid)"
    expected="RESULT=auto-${nonce%%-*}"
    run runner_chat_send "$AGENT_ID" "Reply only ${expected}" "" "auto"
    assert_success
    RUN_ID="$(jq -er '.runId | select(type == "string" and length > 0)' <<<"$output")"
    THREAD_ID="$(jq -er '.threadId | select(type == "string" and length > 0)' <<<"$output")"
    run runner_wait_for_run "$RUN_ID" 180
    assert_success
    first_session="$(jq -er '.result.agentSessionId | select(type == "string" and length > 0)' <<<"$output")"
    run _wait_for_runner_chat_output "$THREAD_ID" "$RUN_ID" "$expected" 60
    assert_success
    run assert_auto_context "$RUN_ID"
    assert_success

    # No explicit model on continuation: the thread keeps Auto and its session.
    run runner_chat_send_after_completion \
        "$AGENT_ID" "$THREAD_ID" "$RUN_ID" \
        "Repeat your previous response exactly." "$expected" 180
    assert_success
    successor_result="$output"
    successor_run_id="$(runner_chat_field "$successor_result" '.runId')"
    [[ "$successor_run_id" != "$RUN_ID" ]]
    [[ "$(runner_chat_field "$successor_result" '.threadId')" == "$THREAD_ID" ]]
    [[ "$(runner_chat_field "$successor_result" '.sessionId')" == "$first_session" ]]
    RUN_ID="$successor_run_id"
    run assert_auto_context "$RUN_ID"
    assert_success
}
