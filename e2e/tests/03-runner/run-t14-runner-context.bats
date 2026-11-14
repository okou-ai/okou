#!/usr/bin/env bats

# Workspace Workflow refresh and personal Instructions at the runner boundary.

load '../../helpers/setup'
load '../../helpers/runner-chat'
load '../../helpers/runner-api'

setup() {
    WORKFLOW_ID=""
    ORIGINAL_INSTRUCTIONS=""
    PERSONAL_INSTRUCTIONS_MARKER=""
    runner_e2e_use_mock_codex_profile
    runner_e2e_require_environment
    runner_e2e_setup_test
    PERSONAL_INSTRUCTIONS_MARKER="PERSONAL_INSTRUCTIONS_${TEST_ID}"
}

teardown() {
    # The workspace default Agent is borrowed, not owned by this test.
    runner_e2e_teardown_test
    if [[ -n "$WORKFLOW_ID" ]]; then
        runner_e2e_delete_workflow "$WORKFLOW_ID" >/dev/null 2>&1 || true
    fi
    if [[ -n "$ORIGINAL_INSTRUCTIONS" ]]; then
        local current restore_payload
        current="$(runner_api_curl "/api/instructions")" || return
        # Recover an uncertain save too, without overwriting another writer.
        if jq -e --arg marker "$PERSONAL_INSTRUCTIONS_MARKER" \
            '.content == $marker' <<<"$current" >/dev/null; then
            restore_payload="$(jq -nc \
                --argjson original "$ORIGINAL_INSTRUCTIONS" \
                --argjson current "$current" \
                '{content: $original.content, ifVersion: $current.version}')" || return
            runner_api_curl "/api/instructions" -X PUT \
                -d "$restore_payload" >/dev/null
        fi
    fi
}

@test "runner refreshes workspace workflow files and mounts personal instructions" {
    run runner_api_curl "/api/onboarding/status"
    echo "$output"
    assert_success
    local agent_id
    agent_id=$(jq -er '.defaultAgentId | select(type == "string" and length > 0)' <<<"$output")

    # This is the mock profile's sole personal-Instructions writer. Parallel
    # shards run their own non-default Agents and retain Agent instructions.
    run runner_api_curl "/api/instructions"
    echo "$output"
    assert_success
    ORIGINAL_INSTRUCTIONS=$(jq -c '{content, version}' <<<"$output")
    local instruction_payload
    instruction_payload=$(jq -nc \
        --arg content "$PERSONAL_INSTRUCTIONS_MARKER" \
        --argjson original "$ORIGINAL_INSTRUCTIONS" \
        '{content: $content, ifVersion: $original.version}')
    run runner_api_curl "/api/instructions" -X PUT -d "$instruction_payload"
    echo "$output"
    assert_success

    local workflow_name="runner-context-${TEST_ID}"
    local workflow_marker="WORKFLOW_FILE_${TEST_ID}"
    local workflow_payload
    workflow_payload=$(jq -nc \
        --arg agentId "$agent_id" \
        --arg name "$workflow_name" \
        --arg marker "$workflow_marker" '
        {
            agentId: $agentId,
            name: $name,
            instruction: "Use the supplementary context files.",
            files: [
                {path: "context.txt", content: $marker},
                {path: "empty.txt", content: ""}
            ]
        }
    ')
    run runner_api_curl "/api/workflows" \
        -X POST \
        -d "$workflow_payload"
    echo "$output"
    assert_success
    WORKFLOW_ID=$(jq -er '.id | select(type == "string" and length > 0)' <<<"$output")

    local output_marker="RUNNER_CONTEXT_OK_${TEST_ID}"
    local prompt
    prompt=$(cat <<'EOF'
set -euo pipefail
grep -F '__INSTRUCTION_MARKER__' "$HOME/.codex/AGENTS.md"
grep -F '__WORKFLOW_MARKER__' "$HOME/.codex/skills/__WORKFLOW_NAME__/context.txt"
test ! -s "$HOME/.codex/skills/__WORKFLOW_NAME__/empty.txt"
test -n "$OKOU_APP_URL"
test -n "$OKOU_AGENT_ID"
test -n "$OKOU_CHAT_THREAD_ID"
test -n "$OKOU_TOKEN"
node -e '
const token = process.env.OKOU_TOKEN;
if (!token?.startsWith("vm0_sandbox_")) throw new Error("OKOU_TOKEN is not a sandbox token");
const claims = JSON.parse(Buffer.from(token.slice("vm0_sandbox_".length).split(".")[1], "base64url"));
if (claims.scope !== "okou") throw new Error("unexpected OKOU_TOKEN scope");
if (!claims.userId || !claims.orgId || !claims.runId) throw new Error("OKOU_TOKEN is missing identity claims");
if (!Array.isArray(claims.capabilities)) throw new Error("OKOU_TOKEN is missing capabilities");
if (!Number.isFinite(claims.iat) || !Number.isFinite(claims.exp) || claims.exp <= claims.iat) throw new Error("OKOU_TOKEN has invalid lifetime claims");
'
printf '__OUTPUT_MARKER__\n'
EOF
)
    prompt=${prompt//__INSTRUCTION_MARKER__/$PERSONAL_INSTRUCTIONS_MARKER}
    prompt=${prompt//__WORKFLOW_MARKER__/$workflow_marker}
    prompt=${prompt//__WORKFLOW_NAME__/$workflow_name}
    prompt=${prompt//__OUTPUT_MARKER__/$output_marker}

    run runner_e2e_start_mock_shell_chat_run "$agent_id" "$prompt"
    echo "$output"
    assert_success
    RUN_ID=$(jq -er '.runId | select(type == "string" and length > 0)' <<<"$output")
    THREAD_ID=$(jq -er '.threadId | select(type == "string" and length > 0)' <<<"$output")

    run runner_wait_for_run "$RUN_ID" 180
    echo "$output"
    assert_success

    run runner_e2e_wait_for_chat_text \
        "$THREAD_ID" \
        "$RUN_ID" \
        "$output_marker"
    echo "$output"
    assert_success
    assert_output --partial "$PERSONAL_INSTRUCTIONS_MARKER"
    assert_output --partial "$workflow_marker"

    local updated_workflow_marker="WORKFLOW_FILE_UPDATED_${TEST_ID}"
    local update_payload
    update_payload=$(jq -nc \
        --arg marker "$updated_workflow_marker" '
        {
            instruction: "Use the refreshed supplementary context files.",
            files: [
                {path: "context.txt", content: $marker},
                {path: "empty.txt", content: ""},
                {path: "added.txt", content: "added-after-update"}
            ]
        }
    ')
    run runner_api_curl "/api/workflows/${WORKFLOW_ID}" \
        -X PATCH \
        -d "$update_payload"
    echo "$output"
    assert_success

    local continuation_marker="RUNNER_CONTEXT_UPDATED_${TEST_ID}"
    local continuation_prompt
    continuation_prompt=$(cat <<'EOF'
set -euo pipefail
grep -F '__UPDATED_WORKFLOW_MARKER__' "$HOME/.codex/skills/__WORKFLOW_NAME__/context.txt"
grep -F 'added-after-update' "$HOME/.codex/skills/__WORKFLOW_NAME__/added.txt"
test ! -s "$HOME/.codex/skills/__WORKFLOW_NAME__/empty.txt"
printf '__CONTINUATION_MARKER__\n'
EOF
)
    continuation_prompt=${continuation_prompt//__UPDATED_WORKFLOW_MARKER__/$updated_workflow_marker}
    continuation_prompt=${continuation_prompt//__WORKFLOW_NAME__/$workflow_name}
    continuation_prompt=${continuation_prompt//__CONTINUATION_MARKER__/$continuation_marker}

    run runner_e2e_continue_chat_run \
        "$agent_id" \
        "$THREAD_ID" \
        "$continuation_prompt"
    echo "$output"
    assert_success
    RUN_ID=$(jq -er '.runId | select(type == "string" and length > 0)' <<<"$output")

    run runner_wait_for_run "$RUN_ID" 180
    echo "$output"
    assert_success

    run runner_e2e_wait_for_chat_text \
        "$THREAD_ID" \
        "$RUN_ID" \
        "$continuation_marker"
    echo "$output"
    assert_success
    assert_output --partial "$updated_workflow_marker"
    assert_output --partial "added-after-update"
}
