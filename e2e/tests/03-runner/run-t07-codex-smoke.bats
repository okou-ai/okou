#!/usr/bin/env bats

# Codex smoke test through the supported agent and chat APIs.

load '../../helpers/setup'
load '../../helpers/runner-chat'

setup_file() {
    require_runner_api_credentials

    export RUNNER_AGENT_ID
    RUNNER_AGENT_ID="$(create_runner_agent \
        "e2e-codex-smoke-$(date +%s%3N)-$RANDOM")"
    set_runner_agent_instructions \
        "$RUNNER_AGENT_ID" \
        "Codex smoke test instructions."
}

teardown_file() {
    if [[ -n "${RUNNER_AGENT_ID:-}" ]]; then
        delete_runner_agent_for_stage0_teardown "$RUNNER_AGENT_ID"
    fi
}

@test "basic codex chat run returns a completed response" {
    run runner_chat_start "$RUNNER_AGENT_ID" "echo from codex"

    assert_success
    assert_output --partial '"status":"completed"'
    assert_output --partial "echo from codex"
    [[ -n "$(runner_chat_field "$output" '.runId')" ]]
    [[ -n "$(runner_chat_field "$output" '.threadId')" ]]
    [[ -n "$(runner_chat_field "$output" '.sessionId')" ]]
}
