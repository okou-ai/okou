#!/usr/bin/env bats

# Independent chat threads on one member must have separate runtime sessions.

load '../../helpers/setup'
load '../../helpers/runner-chat'
load '../../helpers/runner-api'

setup() {
    runner_e2e_use_mock_codex_profile
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
}

@test "independent chat threads use separate runtime sessions" {
    run runner_e2e_start_mock_shell_chat_run \
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
        (.result.frameworkSessionId | type == "string" and length > 0)
    ' <<<"$first_run_response"
    echo "$output"
    assert_success
    local first_session_id
    first_session_id=$(jq -er \
        '.result.frameworkSessionId | select(type == "string" and length > 0)' \
        <<<"$first_run_response")

    run runner_e2e_start_mock_shell_chat_run \
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
        (.result.frameworkSessionId | type == "string" and length > 0)
    ' <<<"$second_run_response"
    echo "$output"
    assert_success
    local second_session_id
    second_session_id=$(jq -er \
        '.result.frameworkSessionId | select(type == "string" and length > 0)' \
        <<<"$second_run_response")

    [[ "$SECOND_THREAD_ID" != "$FIRST_THREAD_ID" ]]
    [[ "$second_session_id" != "$first_session_id" ]]
}
