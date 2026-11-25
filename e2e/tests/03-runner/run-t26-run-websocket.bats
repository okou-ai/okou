#!/usr/bin/env bats

load '../../helpers/setup'
load '../../helpers/runner-chat'
load '../../helpers/runner-api'

setup() {
    runner_e2e_use_mock_codex_profile
    runner_e2e_require_environment
    runner_e2e_setup_live_test
}

teardown() {
    runner_e2e_teardown_test
}

@test "a run owner authenticates over the public Runner WebSocket" {
    run runner_e2e_start_mock_checkpointed_chat_run \
        'printf "WSS_RUN_READY\n"' 'sleep 180'
    assert_success
    THREAD_ID=$(jq -er '.threadId' <<<"$output")
    RUN_ID=$(jq -er '.runId' <<<"$output")

    # The checkpoint proves the Runner has accepted the Run and is executing it.
    run runner_e2e_wait_for_active_chat_text "$THREAD_ID" "$RUN_ID" WSS_RUN_READY
    assert_success

    local bootstrap
    bootstrap=$(runner_api_curl "/api/runs/${RUN_ID}/wss/bootstrap" -X POST)
    node "$TEST_ROOT/scripts/run-websocket.mjs" "$RUN_ID" <<<"$bootstrap"
}
