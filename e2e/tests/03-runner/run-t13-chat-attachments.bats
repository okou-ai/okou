#!/usr/bin/env bats

# Ordinary and empty chat attachments, including same-thread continuation.

load '../../helpers/setup'
load '../../helpers/runner-chat'
load '../../helpers/runner-api'

setup() {
    runner_e2e_use_native_codex_account
    runner_e2e_require_environment
    runner_e2e_setup_test
}

teardown() {
    runner_e2e_teardown_test
}

@test "Okou CLI and chat attachments work across continuation" {
    run create_runner_agent "e2e-chat-attachments-${TEST_ID}"
    echo "$output"
    assert_success
    AGENT_ID="$output"

    local content_marker="ATTACHMENT_CONTENT_${TEST_ID}"
    run runner_e2e_upload_text \
        "runner-content-${TEST_ID}.txt" \
        "$content_marker"
    echo "$output"
    assert_success
    local content_upload="$output"

    run runner_e2e_upload_text "runner-empty-${TEST_ID}.txt" ""
    echo "$output"
    assert_success
    local empty_upload="$output"

    local content_id empty_id first_marker first_prompt shell_prompt parts
    content_id=$(jq -er '.id' <<<"$content_upload")
    empty_id=$(jq -er '.id' <<<"$empty_upload")
    first_marker="ATTACHMENTS_OK_${TEST_ID}"
    first_prompt=$(cat <<'EOF'
set -euo pipefail
test "$npm_config_cache" = "/home/user/workspace/.vm0/cache/npm"
# Prove the artifact supports the canonical executable and guest-agent boundary
# before using Okou for attachment operations.
okou_help="$(npx --yes --package="${CLI_PKG_URL}" okou --help)"
test -d "$npm_config_cache"
grep -F 'Usage: okou' <<<"$okou_help"
agent_loop_help="$(npx --yes --package="${CLI_PKG_URL}" okou __agent-loop --help)"
grep -F 'Internal sandbox Pi agent loop' <<<"$agent_loop_help"
npx --yes --package="${CLI_PKG_URL}" okou web download-file '__CONTENT_ID__' -o /tmp/runner-content.txt
npx --yes --package="${CLI_PKG_URL}" okou web download-file '__EMPTY_ID__' -o /tmp/runner-empty.txt
grep -F '__CONTENT_MARKER__' /tmp/runner-content.txt
test ! -s /tmp/runner-empty.txt
printf '__FIRST_MARKER__\n'
EOF
)
    first_prompt=${first_prompt//__CONTENT_ID__/$content_id}
    first_prompt=${first_prompt//__EMPTY_ID__/$empty_id}
    first_prompt=${first_prompt//__CONTENT_MARKER__/$content_marker}
    first_prompt=${first_prompt//__FIRST_MARKER__/$first_marker}
    shell_prompt=$(runner_e2e_shell_prompt "$first_prompt")
    parts=$(jq -nc \
        --arg prompt "$shell_prompt" \
        --arg contentId "$content_id" \
        --arg contentFilename "$(jq -er '.filename' <<<"$content_upload")" \
        --arg contentType "$(jq -er '.contentType' <<<"$content_upload")" \
        --arg emptyId "$empty_id" \
        --arg emptyFilename "$(jq -er '.filename' <<<"$empty_upload")" \
        --arg emptyContentType "$(jq -er '.contentType' <<<"$empty_upload")" '
        [
            {type: "text", text: $prompt},
            {
                type: "file",
                fileId: $contentId,
                filenameSnapshot: $contentFilename,
                contentType: $contentType
            },
            {
                type: "file",
                fileId: $emptyId,
                filenameSnapshot: $emptyFilename,
                contentType: $emptyContentType
            }
        ]
    ')

    run runner_chat_send_parts \
        "$AGENT_ID" \
        "$shell_prompt" \
        "$parts" \
        "" \
        "$E2E_NATIVE_CODEX_MODEL"
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
    run runner_e2e_wait_for_chat_text \
        "$THREAD_ID" \
        "$first_run_id" \
        "$first_marker"
    echo "$output"
    assert_success
    assert_output --partial "$content_marker"
    refute_output --partial "mock shell exited with"

    local continuation_marker="ATTACHMENT_CONTINUED_${TEST_ID}"
    local continuation_prompt
    continuation_prompt=$(cat <<'EOF'
set -euo pipefail
test "$npm_config_cache" = "/home/user/workspace/.vm0/cache/npm"
# Continuation can restore session history in a fresh sandbox, so re-download
# the attachments instead of depending on runner-local files from the first run.
npx --yes --package="${CLI_PKG_URL}" okou web download-file '__CONTENT_ID__' -o /tmp/runner-content-continuation.txt
test -d "$npm_config_cache"
npx --yes --package="${CLI_PKG_URL}" okou web download-file '__EMPTY_ID__' -o /tmp/runner-empty-continuation.txt
grep -F '__CONTENT_MARKER__' /tmp/runner-content-continuation.txt
test ! -s /tmp/runner-empty-continuation.txt
printf '__CONTINUATION_MARKER__\n'
EOF
)
    continuation_prompt=${continuation_prompt//__CONTENT_ID__/$content_id}
    continuation_prompt=${continuation_prompt//__EMPTY_ID__/$empty_id}
    continuation_prompt=${continuation_prompt//__CONTENT_MARKER__/$content_marker}
    continuation_prompt=${continuation_prompt//__CONTINUATION_MARKER__/$continuation_marker}
    run runner_e2e_continue_chat_run \
        "$AGENT_ID" \
        "$THREAD_ID" \
        "$continuation_prompt"
    echo "$output"
    assert_success
    RUN_ID=$(jq -er '.runId | select(type == "string" and length > 0)' <<<"$output")

    run runner_wait_for_run "$RUN_ID" 180
    echo "$output"
    assert_success
    local continuation_run_response="$output"
    run runner_e2e_wait_for_chat_text \
        "$THREAD_ID" \
        "$RUN_ID" \
        "$continuation_marker"
    echo "$output"
    assert_success
    assert_output --partial "$content_marker"

    [[ "$(jq -er '.result.agentSessionId' <<<"$continuation_run_response")" == \
        "$(jq -er '.result.agentSessionId' <<<"$first_run_response")" ]]
}
