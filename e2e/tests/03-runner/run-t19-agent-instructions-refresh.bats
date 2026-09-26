#!/usr/bin/env bats

# Agent instructions refresh across same-thread continuation.

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

@test "same-thread continuation refreshes mounted agent instructions" {
    run create_runner_agent "e2e-agent-instructions-refresh-${TEST_ID}"
    echo "$output"
    assert_success
    AGENT_ID="$output"

    local initial_instruction_marker="AGENT_INSTRUCTIONS_INITIAL_${TEST_ID}"
    local updated_instruction_marker="AGENT_INSTRUCTIONS_UPDATED_${TEST_ID}"
    run set_runner_agent_instructions "$AGENT_ID" "$initial_instruction_marker"
    echo "$output"
    assert_success

    local first_output_marker="AGENT_INSTRUCTIONS_FIRST_TURN_${TEST_ID}"
    local first_prompt
    first_prompt=$(cat <<'EOF'
set -euo pipefail
grep -F '__INITIAL_INSTRUCTION_MARKER__' "$HOME/.codex/AGENTS.md"
! grep -F '__UPDATED_INSTRUCTION_MARKER__' "$HOME/.codex/AGENTS.md"
printf '__FIRST_OUTPUT_MARKER__\n'
EOF
)
    first_prompt=${first_prompt//__INITIAL_INSTRUCTION_MARKER__/$initial_instruction_marker}
    first_prompt=${first_prompt//__UPDATED_INSTRUCTION_MARKER__/$updated_instruction_marker}
    first_prompt=${first_prompt//__FIRST_OUTPUT_MARKER__/$first_output_marker}

    run runner_e2e_start_mock_shell_chat_run "$AGENT_ID" "$first_prompt"
    echo "$output"
    assert_success
    local first_run_id
    first_run_id=$(jq -er '.runId | select(type == "string" and length > 0)' <<<"$output")
    RUN_ID="$first_run_id"
    THREAD_ID=$(jq -er '.threadId | select(type == "string" and length > 0)' <<<"$output")

    run runner_wait_for_run "$first_run_id" 180
    echo "$output"
    assert_success
    local first_run_response="$output"
    local first_session_id
    first_session_id=$(jq -er \
        '.result.agentSessionId | select(type == "string" and length > 0)' \
        <<<"$first_run_response")

    run runner_e2e_wait_for_chat_text \
        "$THREAD_ID" \
        "$first_run_id" \
        "$first_output_marker"
    echo "$output"
    assert_success
    assert_output --partial "$initial_instruction_marker"

    run set_runner_agent_instructions "$AGENT_ID" "$updated_instruction_marker"
    echo "$output"
    assert_success

    local continuation_output_marker="AGENT_INSTRUCTIONS_CONTINUED_${TEST_ID}"
    local continuation_prompt
    continuation_prompt=$(cat <<'EOF'
set -euo pipefail
grep -F '__UPDATED_INSTRUCTION_MARKER__' "$HOME/.codex/AGENTS.md"
! grep -F '__INITIAL_INSTRUCTION_MARKER__' "$HOME/.codex/AGENTS.md"
printf '__CONTINUATION_OUTPUT_MARKER__\n'
EOF
)
    continuation_prompt=${continuation_prompt//__UPDATED_INSTRUCTION_MARKER__/$updated_instruction_marker}
    continuation_prompt=${continuation_prompt//__INITIAL_INSTRUCTION_MARKER__/$initial_instruction_marker}
    continuation_prompt=${continuation_prompt//__CONTINUATION_OUTPUT_MARKER__/$continuation_output_marker}

    run runner_e2e_continue_chat_run \
        "$AGENT_ID" \
        "$THREAD_ID" \
        "$continuation_prompt"
    echo "$output"
    assert_success
    local continuation_send_response="$output"
    run jq -e --arg threadId "$THREAD_ID" --arg firstRunId "$first_run_id" '
        .threadId == $threadId and
        (.runId | type == "string" and length > 0) and
        .runId != $firstRunId
    ' <<<"$continuation_send_response"
    echo "$output"
    assert_success
    RUN_ID=$(jq -er '.runId' <<<"$continuation_send_response")

    run runner_wait_for_run "$RUN_ID" 180
    echo "$output"
    assert_success
    local continuation_run_response="$output"
    local continuation_session_id
    continuation_session_id=$(jq -er \
        '.result.agentSessionId | select(type == "string" and length > 0)' \
        <<<"$continuation_run_response")

    run runner_e2e_wait_for_chat_text \
        "$THREAD_ID" \
        "$RUN_ID" \
        "$continuation_output_marker"
    echo "$output"
    assert_success
    assert_output --partial "$updated_instruction_marker"

    [[ "$continuation_session_id" == "$first_session_id" ]]
}
