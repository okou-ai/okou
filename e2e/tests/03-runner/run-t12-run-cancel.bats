#!/usr/bin/env bats

# Cancellation coverage through the deployed public run and chat-event APIs.

load '../../helpers/setup'
load '../../helpers/runner-chat'
load '../../helpers/runner-api'

setup() {
    runner_e2e_use_mock_codex_profile
    runner_e2e_require_environment
    runner_e2e_setup_test
}

teardown() {
    runner_e2e_teardown_test
}

@test "public run API cancels a running sandbox" {
    run create_runner_agent "e2e-run-cancel-${TEST_ID}"
    echo "$output"
    assert_success
    AGENT_ID="$output"

    run runner_e2e_start_mock_shell_chat_run "$AGENT_ID" $'set -euo pipefail\nsleep 300'
    echo "$output"
    assert_success
    RUN_ID=$(jq -er '.runId | select(type == "string" and length > 0)' <<<"$output")
    THREAD_ID=$(jq -er '.threadId | select(type == "string" and length > 0)' <<<"$output")

    run runner_e2e_wait_for_run_status "$RUN_ID" running
    echo "$output"
    assert_success

    run runner_e2e_cancel_run "$RUN_ID"
    echo "$output"
    assert_success
    run jq -e '.status == "cancelled"' <<<"$output"
    echo "$output"
    assert_success

    run runner_e2e_wait_for_run_status "$RUN_ID" cancelled
    echo "$output"
    assert_success

    run runner_e2e_wait_for_chat_event \
        "$THREAD_ID" \
        "$RUN_ID" \
        run.cancelled
    echo "$output"
    assert_success
}
