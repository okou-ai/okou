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

@test "personal codex subscription returns a completed native response" {
    run runner_api_curl "/api/run-models"
    assert_success
    run jq -e --arg model "$E2E_MOCK_CODEX_MODEL" '
        .models[0].model == null and
        any(.models[]?;
            .model == $model and
            .memberEffective.providerType == "codex-oauth-token" and
            .memberEffective.credentialScope == "member"
        )
    ' <<<"$output"
    assert_success

    run runner_chat_start_mock_codex "$RUNNER_AGENT_ID" "echo from codex"

    assert_success
    assert_output --partial '"status":"completed"'
    assert_output --partial "echo from codex"
    [[ -n "$(runner_chat_field "$output" '.runId')" ]]
    [[ -n "$(runner_chat_field "$output" '.threadId')" ]]
    [[ -n "$(runner_chat_field "$output" '.sessionId')" ]]
    local run_id
    run_id="$(runner_chat_field "$output" '.runId')"
    run runner_e2e_wait_for_run_context "$run_id"
    assert_success
    run jq -e '
        .cliAgentType == "codex" and
        any(.firewalls[]?; .name == "model-provider:codex-oauth-token")
    ' <<<"$output"
    assert_success
}
