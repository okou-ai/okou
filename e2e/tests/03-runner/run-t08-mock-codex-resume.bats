#!/usr/bin/env bats

# Mock Codex resume test through two supported sends on the same chat thread.

load '../../helpers/setup'
load '../../helpers/runner-chat'
load '../../helpers/runner-api'

setup_file() {
    runner_e2e_use_mock_codex_profile
    require_runner_api_credentials
}

@test "second chat turn resumes the mock codex session" {
    run runner_chat_start_mock_codex "" "first turn"

    assert_success
    assert_output --partial '"status":"completed"'
    assert_output --partial "first turn"

    local first_output="$output"
    local thread_id first_session_id
    thread_id="$(runner_chat_field "$first_output" '.threadId')"
    first_session_id="$(runner_chat_field "$first_output" '.sessionId')"

    run runner_chat_continue "" "$thread_id" "second turn"

    assert_success
    assert_output --partial '"status":"completed"'
    assert_output --partial "second turn"

    local second_thread_id second_session_id
    second_thread_id="$(runner_chat_field "$output" '.threadId')"
    second_session_id="$(runner_chat_field "$output" '.sessionId')"
    [[ "$second_thread_id" == "$thread_id" ]]
    [[ "$second_session_id" == "$first_session_id" ]]
}
