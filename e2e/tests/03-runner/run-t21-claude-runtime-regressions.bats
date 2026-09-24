#!/usr/bin/env bats

# Mock Claude runtime regressions through the deployed public chat flow.

load '../../helpers/setup'
load '../../helpers/runner-chat'
load '../../helpers/runner-api'

setup() {
    local credentials="/tmp/e2e-api-credentials-runner-mock-claude.json"
    export E2E_API_TOKEN E2E_API_URL
    E2E_API_TOKEN="$(jq -er '.token | select(type == "string" and length > 0)' "$credentials")"
    E2E_API_URL="$(jq -er '.apiUrl | select(type == "string" and length > 0)' "$credentials")"
    runner_e2e_require_environment
    runner_e2e_setup_test
}

teardown() {
    runner_e2e_teardown_test
}

@test "public chat filters mock Claude JSONL stream noise" {
    run create_runner_agent "e2e-mock-claude-echo-${TEST_ID}"
    echo "$output"
    assert_success
    AGENT_ID="$output"

    local session_id assistant_text protocol_noise prompt
    session_id="$(_runner_uuid)"
    assistant_text="echo-jsonl fixture response"
    protocol_noise="partial echo that should stay out of chat"
    prompt=$(cat <<EOF
@ECHO@
{"type":"system","subtype":"init","cwd":"/home/user/workspace","session_id":"$session_id","tools":["Bash"],"model":"mock-claude"}
{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_echo_01"}}}
{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"$protocol_noise"}}}
{"type":"stream_event","event":{"type":"content_block_stop"}}
{"type":"stream_event","event":{"type":"message_stop"}}
{"type":"assistant","session_id":"$session_id","message":{"role":"assistant","content":[{"type":"text","text":"$assistant_text"}]}}
{"type":"result","subtype":"success","session_id":"$session_id","is_error":false,"duration_ms":100,"num_turns":1,"result":"Done.","total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0}}
EOF
)

    run runner_chat_send "$AGENT_ID" "$prompt" "" "claude-sonnet-5"
    echo "$output"
    assert_success
    RUN_ID=$(jq -er '.runId | select(type == "string" and length > 0)' <<<"$output")
    THREAD_ID=$(jq -er '.threadId | select(type == "string" and length > 0)' <<<"$output")

    run runner_wait_for_run "$RUN_ID" 120
    echo "$output"
    assert_success
    run jq -e '
        .status == "completed" and
        (.result.agentSessionId | type == "string" and length > 0)
    ' <<<"$output"
    echo "$output"
    assert_success

    run _wait_for_runner_chat_completion "$THREAD_ID" "$RUN_ID" 45
    echo "$output"
    assert_success
    assert_output "$assistant_text"

    run runner_chat_event_rows "$THREAD_ID"
    echo "$output"
    assert_success
    local chat_events="$output"
    run jq -e \
        --arg runId "$RUN_ID" \
        --arg assistantText "$assistant_text" \
        --arg protocolNoise "$protocol_noise" '
        [.rows[]? |
            select(.eventType == "output.message" and .runId == $runId) |
            .payload.content
        ] as $outputs |
        ($outputs == [$assistantText]) and
        all($outputs[]; contains($protocolNoise) | not) and
        any(.rows[]?;
            .eventType == "run.completed" and .runId == $runId
        )
    ' <<<"$chat_events"
    echo "$output"
    assert_success
}

@test "public chat completes after draining an orphaned Claude stdout pipe" {
    run create_runner_agent "e2e-mock-claude-orphan-pipe-${TEST_ID}"
    echo "$output"
    assert_success
    AGENT_ID="$output"

    run runner_chat_send "$AGENT_ID" "@orphan-pipe" "" "claude-sonnet-5"
    echo "$output"
    assert_success
    RUN_ID=$(jq -er '.runId | select(type == "string" and length > 0)' <<<"$output")
    THREAD_ID=$(jq -er '.threadId | select(type == "string" and length > 0)' <<<"$output")

    local started_at=$SECONDS
    run runner_wait_for_run "$RUN_ID" 90
    local elapsed=$((SECONDS - started_at))
    echo "$output"
    assert_success
    ((elapsed < 90))
    run jq -e '
        .status == "completed" and
        (.result.agentSessionId | type == "string" and length > 0)
    ' <<<"$output"
    echo "$output"
    assert_success

    run _wait_for_runner_chat_completion "$THREAD_ID" "$RUN_ID" 45
    echo "$output"
    assert_success
    assert_output "Done."

    run runner_chat_event_rows "$THREAD_ID"
    echo "$output"
    assert_success
    local chat_events="$output"
    run jq -e --arg runId "$RUN_ID" '
        ([.rows[]? |
            select(.eventType == "output.message" and .runId == $runId) |
            .payload.content
        ] == ["Done."]) and
        any(.rows[]?;
            .eventType == "run.completed" and .runId == $runId
        )
    ' <<<"$chat_events"
    echo "$output"
    assert_success
}
