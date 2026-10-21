#!/usr/bin/env bats

# Platform Auto smoke and Pi/OpenRouter capability through supported public APIs.
# Personal Claude remains covered by run-t21-claude-runtime-regressions.bats.

load '../../helpers/setup'
load '../../helpers/runner-chat'
load '../../helpers/runner-api'

BATS_TEST_TIMEOUT=600

setup() {
    local credentials="/tmp/e2e-api-credentials-runner-real-codex.json"
    export E2E_API_TOKEN E2E_API_URL
    E2E_API_TOKEN="$(jq -er '.token | select(type == "string" and length > 0)' "$credentials")"
    E2E_API_URL="$(jq -er '.apiUrl | select(type == "string" and length > 0)' "$credentials")"
    runner_e2e_require_environment
    runner_e2e_setup_test
}

teardown() {
    runner_e2e_teardown_test
}

@test "auto completes a real Pi answer through the OpenRouter preset" {
    run runner_api_curl "/api/run-models"
    assert_success
    run jq -e '
        (has("defaultModel") | not) and
        (.models | length == 1) and
        .models[0].model == "auto" and
        .models[0].memberEffective.providerType == "built-in" and
        .models[0].memberEffective.credentialScope == "org" and
        .models[0].modelProviderId == null
    ' <<<"$output"
    assert_success

    run create_runner_agent "e2e-auto-pi-${TEST_ID}"
    assert_success
    AGENT_ID="$output"
    run set_runner_agent_instructions "$AGENT_ID" "Auto Pi smoke test instructions."
    assert_success

    # Omit a model on a new chat to exercise the product default, not just an
    # explicit-model happy path. Bootstrap sets the member preference to Auto.
    # This platform-default case must not inherit a mock Codex profile selection.
    E2E_MOCK_CODEX_MODEL="" run runner_chat_send "$AGENT_ID" "What is 1 + 2? Reply with only the number." "" ""
    assert_success
    RUN_ID="$(jq -er '.runId | select(type == "string" and length > 0)' <<<"$output")"
    THREAD_ID="$(jq -er '.threadId | select(type == "string" and length > 0)' <<<"$output")"
    run runner_wait_for_run "$RUN_ID" 180
    assert_success
    run jq -e '
        .status == "completed" and
        (.result.frameworkSessionId | type == "string" and length > 0) and
        .source.providerType == "built-in" and
        .source.runtimeProviderType == "openrouter-codex" and
        .source.model == "auto" and
        .source.credentialScope == "org"
    ' <<<"$output"
    assert_success
    run _wait_for_runner_chat_completion "$THREAD_ID" "$RUN_ID" 60
    assert_success
    assert_output --regexp '^[[:space:]]*3[[:space:]]*$'
}
