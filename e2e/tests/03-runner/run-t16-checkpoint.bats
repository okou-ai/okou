#!/usr/bin/env bats

# Completed-run checkpoint coverage through the supported agent, chat, and run APIs.

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

@test "completed chat run exposes a checkpoint id" {
    run create_runner_agent "e2e-run-checkpoint-${TEST_ID}"
    echo "$output"
    assert_success
    AGENT_ID="$output"

    local marker="CHECKPOINT_COMPLETED_${TEST_ID}"
    run runner_e2e_start_mock_shell_chat_run \
        "$AGENT_ID" \
        "printf '${marker}\\n'"
    echo "$output"
    assert_success
    RUN_ID=$(jq -er '.runId | select(type == "string" and length > 0)' <<<"$output")
    THREAD_ID=$(jq -er '.threadId | select(type == "string" and length > 0)' <<<"$output")

    run runner_e2e_wait_for_run_status "$RUN_ID" completed 180
    echo "$output"
    assert_success

    run runner_api_curl "/api/runs/${RUN_ID}"
    echo "$output"
    assert_success
    run jq -e '
        .status == "completed" and
        (.result.checkpointId | type == "string" and length > 0)
    ' <<<"$output"
    echo "$output"
    assert_success
}
