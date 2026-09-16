#!/usr/bin/env bats

# Real Luna smoke and built-in usage attribution through public APIs.

load '../../helpers/setup'
load '../../helpers/runner-chat'
load '../../helpers/runner-api'

setup() {
    local credentials="/tmp/e2e-api-credentials-runner-real-claude.json"
    export E2E_API_TOKEN E2E_API_URL
    E2E_API_TOKEN="$(jq -er '.token | select(type == "string" and length > 0)' "$credentials")"
    E2E_API_URL="$(jq -er '.apiUrl | select(type == "string" and length > 0)' "$credentials")"
    runner_e2e_require_environment
    runner_e2e_setup_test
}

teardown() {
    runner_e2e_teardown_test
}

@test "real luna reports built-in model usage" {
    run create_runner_agent "e2e-real-luna-${TEST_ID}"
    echo "$output"
    assert_success
    AGENT_ID="$output"

    run set_runner_agent_instructions \
        "$AGENT_ID" \
        "Real Luna billing smoke test instructions."
    echo "$output"
    assert_success

    # The Codex account uses Luna for BYOK steering. The real Claude/Pi
    # account keeps Luna built-in, so billing and steering can run concurrently
    # without changing either organization's model policies.
    run runner_api_curl "/api/model-policies"
    echo "$output"
    assert_success
    run jq -e '
        any(.policies[]?;
            .model == "gpt-5.6-luna" and
            .defaultProviderType == "built-in" and
            .credentialScope == "org" and
            .modelProviderId == null
        )
    ' <<<"$output"
    echo "$output"
    assert_success

    local prompt="Briefly confirm that the real Luna model is responding."
    run runner_chat_send "$AGENT_ID" "$prompt" "" "gpt-5.6-luna"
    echo "$output"
    assert_success
    RUN_ID=$(jq -er '.runId | select(type == "string" and length > 0)' <<<"$output")
    THREAD_ID=$(jq -er '.threadId | select(type == "string" and length > 0)' <<<"$output")

    run runner_wait_for_run "$RUN_ID" 180
    echo "$output"
    assert_success
    run jq -e '
        .status == "completed" and
        (.result.agentSessionId | type == "string" and length > 0)
    ' <<<"$output"
    echo "$output"
    assert_success

    run _wait_for_runner_chat_completion "$THREAD_ID" "$RUN_ID" 60
    echo "$output"
    assert_success

    # Preview deployments do not schedule the production usage cron. Once the
    # first run's asynchronous usage upload has arrived, cancelling a fresh
    # pending run exercises the public cancellation reconciliation for the same
    # organization and settles that usage without an internal test endpoint.
    run runner_chat_send \
        "$AGENT_ID" \
        "This follow-up run should be cancelled immediately." \
        "$THREAD_ID" \
        ""
    echo "$output"
    assert_success
    local settlement_run_id
    settlement_run_id=$(jq -er \
        '.runId | select(type == "string" and length > 0)' \
        <<<"$output")
    run jq -e '.status == "pending"' <<<"$output"
    echo "$output"
    assert_success

    run runner_e2e_cancel_run "$settlement_run_id"
    echo "$output"
    assert_success
    run jq -e '.status == "cancelled"' <<<"$output"
    echo "$output"
    assert_success
    run runner_e2e_wait_for_chat_event \
        "$THREAD_ID" \
        "$settlement_run_id" \
        run.cancelled
    echo "$output"
    assert_success

    run runner_e2e_wait_for_usage_event \
        "$THREAD_ID" \
        "$RUN_ID" \
        "gpt-5.6-luna"
    echo "$output"
    assert_success

    run runner_e2e_wait_for_usage_record "$THREAD_ID" "gpt-5.6-luna"
    echo "$output"
    assert_success
    local usage_record="$output"
    run jq -e --arg threadId "$THREAD_ID" '
        any(.rows[]?;
            .threadId == $threadId and
            .credits > 0 and
            .tokens > 0 and
            any(.breakdown[]?;
                .kind == "model" and
                any(.providers[]?;
                    .provider == "gpt-5.6-luna" and .credits > 0
                )
            )
        )
    ' <<<"$usage_record"
    echo "$output"
    assert_success
}
