#!/usr/bin/env bats

# Codex resume test through two supported sends on the same chat thread.

load '../../helpers/setup'
load '../../helpers/runner-chat'

setup_file() {
    require_runner_api_credentials

    export RUNNER_AGENT_ID
    RUNNER_AGENT_ID="$(create_runner_agent \
        "e2e-codex-resume-$(date +%s%3N)-$RANDOM")"
    set_runner_agent_instructions \
        "$RUNNER_AGENT_ID" \
        "Codex resume test instructions."
}

teardown_file() {
    if [[ -n "${RUNNER_AGENT_ID:-}" ]]; then
        delete_runner_agent_for_stage0_teardown "$RUNNER_AGENT_ID"
    fi
}

@test "second chat turn resumes the codex session" {
    run runner_chat_start "$RUNNER_AGENT_ID" "first turn"

    assert_success
    assert_output --partial '"status":"completed"'
    assert_output --partial "first turn"

    local first_output="$output"
    local thread_id first_session_id
    thread_id="$(runner_chat_field "$first_output" '.threadId')"
    first_session_id="$(runner_chat_field "$first_output" '.sessionId')"

    run runner_chat_continue "$RUNNER_AGENT_ID" "$thread_id" "second turn"

    assert_success
    assert_output --partial '"status":"completed"'
    assert_output --partial "second turn"

    local second_thread_id second_session_id
    second_thread_id="$(runner_chat_field "$output" '.threadId')"
    second_session_id="$(runner_chat_field "$output" '.sessionId')"
    [[ "$second_thread_id" == "$thread_id" ]]
    [[ "$second_session_id" == "$first_session_id" ]]
}
