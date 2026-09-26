#!/usr/bin/env bats

# Workflow file refresh and agent instructions at the runner boundary.

load '../../helpers/setup'
load '../../helpers/runner-chat'
load '../../helpers/runner-api'

setup() {
    runner_e2e_use_mock_codex_profile
    runner_e2e_require_environment
    runner_e2e_setup_test
    WORKFLOW_ID=""
}

teardown() {
    if [[ -n "$WORKFLOW_ID" ]]; then
        runner_e2e_delete_workflow "$WORKFLOW_ID" >/dev/null 2>&1 || true
    fi
    runner_e2e_teardown_test
}

@test "runner refreshes workflow files and mounts instructions" {
    run create_runner_agent "e2e-runner-context-${TEST_ID}"
    echo "$output"
    assert_success
    AGENT_ID="$output"

    local instruction_marker="AGENT_INSTRUCTION_${TEST_ID}"
    run set_runner_agent_instructions "$AGENT_ID" "$instruction_marker"
    echo "$output"
    assert_success

    local workflow_name="runner-context-${TEST_ID}"
    local workflow_marker="WORKFLOW_FILE_${TEST_ID}"
    local workflow_payload
    workflow_payload=$(jq -nc \
        --arg agentId "$AGENT_ID" \
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
    prompt=${prompt//__INSTRUCTION_MARKER__/$instruction_marker}
    prompt=${prompt//__WORKFLOW_MARKER__/$workflow_marker}
    prompt=${prompt//__WORKFLOW_NAME__/$workflow_name}
    prompt=${prompt//__OUTPUT_MARKER__/$output_marker}

    run runner_e2e_start_mock_shell_chat_run "$AGENT_ID" "$prompt"
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
    assert_output --partial "$instruction_marker"
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
        "$AGENT_ID" \
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
