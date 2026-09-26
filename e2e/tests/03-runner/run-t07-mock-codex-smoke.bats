#!/usr/bin/env bats

# Mock Codex smoke test through the supported agent and chat APIs.

load '../../helpers/setup'
load '../../helpers/runner-chat'
load '../../helpers/runner-api'

setup_file() {
    runner_e2e_use_mock_codex_profile
    require_runner_api_credentials

    export RUNNER_AGENT_ID
    RUNNER_AGENT_ID="$(create_runner_agent \
        "e2e-codex-smoke-$(date +%s%3N)-$RANDOM")"
    set_runner_agent_instructions \
        "$RUNNER_AGENT_ID" \
        "Codex smoke test instructions."
}

setup() {
    runner_e2e_use_mock_codex_profile
}

teardown_file() {
    runner_e2e_use_mock_codex_profile
    if [[ -n "${RUNNER_AGENT_ID:-}" ]]; then
        delete_runner_agent_for_stage0_teardown "$RUNNER_AGENT_ID"
    fi
}

@test "mock codex chat run returns a completed response" {
    run runner_chat_start_mock_codex "$RUNNER_AGENT_ID" "echo from codex"

    assert_success
    assert_output --partial '"status":"completed"'
    assert_output --partial "echo from codex"
    [[ -n "$(runner_chat_field "$output" '.runId')" ]]
    [[ -n "$(runner_chat_field "$output" '.threadId')" ]]
    [[ -n "$(runner_chat_field "$output" '.sessionId')" ]]
}
