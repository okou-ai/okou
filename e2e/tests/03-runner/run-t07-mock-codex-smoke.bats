#!/usr/bin/env bats

# Mock Codex smoke test through the chat API.

load '../../helpers/setup'
load '../../helpers/runner-chat'
load '../../helpers/runner-api'

setup_file() {
    runner_e2e_use_mock_codex_profile
    require_runner_api_credentials
}

setup() {
    runner_e2e_use_mock_codex_profile
}

@test "personal codex subscription returns a completed native response" {
    run runner_api_curl "/api/run-models"
    assert_success
    run jq -e --arg model "$E2E_MOCK_CODEX_MODEL" '
        .models[0].model == "auto" and
        any(.models[]?;
            .model == $model and
            .memberEffective.providerType == "codex-oauth-token" and
            .memberEffective.credentialScope == "member"
        )
    ' <<<"$output"
    assert_success

    run runner_chat_start_mock_codex "echo from codex"

    assert_success
    assert_output --partial '"status":"completed"'
    assert_output --partial "echo from codex"
    [[ -n "$(runner_chat_field "$output" '.runId')" ]]
    [[ -n "$(runner_chat_field "$output" '.threadId')" ]]
    [[ -n "$(runner_chat_field "$output" '.sessionId')" ]]
    local run_id
    run_id="$(runner_chat_field "$output" '.runId')"
    run runner_api_curl "/api/runs/${run_id}"
    assert_success
    run jq -e --arg runId "$run_id" --arg model "$E2E_MOCK_CODEX_MODEL" '
        .runId == $runId and
        .status == "completed" and
        .source.providerType == "codex-oauth-token" and
        .source.runtimeProviderType == "codex-oauth-token" and
        .source.model == $model and
        .source.credentialScope == "member" and
        .source.account.status == "connected"
    ' <<<"$output"
    assert_success
}
