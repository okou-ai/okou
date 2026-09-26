#!/usr/bin/env bats

# Independent chat threads on one agent must not share an agent session.

load '../../helpers/setup'
load '../../helpers/runner-chat'
load '../../helpers/runner-api'

setup() {
    runner_e2e_use_native_codex_account
    runner_e2e_require_environment
    runner_e2e_setup_test
    FIRST_RUN_ID=""
    FIRST_THREAD_ID=""
    SECOND_RUN_ID=""
    SECOND_THREAD_ID=""
}

teardown() {
    if [[ -n "${FIRST_RUN_ID:-}" ]]; then
        runner_e2e_cancel_run "$FIRST_RUN_ID" >/dev/null 2>&1 || true
    fi
    if [[ -n "${SECOND_RUN_ID:-}" ]]; then
        runner_e2e_cancel_run "$SECOND_RUN_ID" >/dev/null 2>&1 || true
    fi
    if [[ -n "${FIRST_THREAD_ID:-}" ]]; then
        runner_e2e_delete_chat_thread "$FIRST_THREAD_ID" >/dev/null 2>&1 || true
    fi
    if [[ -n "${SECOND_THREAD_ID:-}" ]]; then
        runner_e2e_delete_chat_thread "$SECOND_THREAD_ID" >/dev/null 2>&1 || true
    fi
    if [[ -n "${AGENT_ID:-}" ]]; then
        delete_runner_agent "$AGENT_ID" >/dev/null 2>&1 || true
    fi
}

@test "independent chat threads use separate agent sessions" {
    run create_runner_agent "e2e-independent-thread-sessions-${TEST_ID}"
    echo "$output"
    assert_success
    AGENT_ID="$output"

    run set_runner_agent_instructions \
        "$AGENT_ID" \
        "Independent thread session isolation test instructions."
    echo "$output"
    assert_success

    run runner_e2e_start_chat_run \
        "$AGENT_ID" \
        "printf 'FIRST_INDEPENDENT_THREAD_${TEST_ID}\\n'"
    echo "$output"
    assert_success
    FIRST_RUN_ID=$(jq -er '.runId | select(type == "string" and length > 0)' <<<"$output")
    FIRST_THREAD_ID=$(jq -er '.threadId | select(type == "string" and length > 0)' <<<"$output")

    run runner_wait_for_run "$FIRST_RUN_ID" 180
    echo "$output"
    assert_success
    local first_run_response="$output"
    run jq -e '
        .status == "completed" and
        (.result.agentSessionId | type == "string" and length > 0)
    ' <<<"$first_run_response"
    echo "$output"
    assert_success
    local first_session_id
    first_session_id=$(jq -er \
        '.result.agentSessionId | select(type == "string" and length > 0)' \
        <<<"$first_run_response")

    run runner_e2e_start_chat_run \
        "$AGENT_ID" \
        "printf 'SECOND_INDEPENDENT_THREAD_${TEST_ID}\\n'"
    echo "$output"
    assert_success
    SECOND_RUN_ID=$(jq -er '.runId | select(type == "string" and length > 0)' <<<"$output")
    SECOND_THREAD_ID=$(jq -er '.threadId | select(type == "string" and length > 0)' <<<"$output")

    run runner_wait_for_run "$SECOND_RUN_ID" 180
    echo "$output"
    assert_success
    local second_run_response="$output"
    run jq -e '
        .status == "completed" and
        (.result.agentSessionId | type == "string" and length > 0)
    ' <<<"$second_run_response"
    echo "$output"
    assert_success
    local second_session_id
    second_session_id=$(jq -er \
        '.result.agentSessionId | select(type == "string" and length > 0)' \
        <<<"$second_run_response")

    [[ "$SECOND_THREAD_ID" != "$FIRST_THREAD_ID" ]]
    [[ "$second_session_id" != "$first_session_id" ]]
}
