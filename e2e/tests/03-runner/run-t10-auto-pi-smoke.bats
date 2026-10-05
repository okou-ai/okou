#!/usr/bin/env bats

# Platform Auto smoke and Pi/OpenRouter capability through supported public APIs.
# Personal Claude remains covered by run-t21-claude-runtime-regressions.bats.

load '../../helpers/setup'
load '../../helpers/runner-chat'
load '../../helpers/runner-api'

BATS_TEST_TIMEOUT=600

setup() {
    local credentials="/tmp/e2e-api-credentials-runner-real-claude.json"
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
        .defaultModel == "okou-1.0" and
        (.models | length == 1) and
        .models[0].model == "okou-1.0" and
        .models[0].defaultProviderType == "built-in" and
        .models[0].credentialScope == "org" and
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
    run runner_chat_send "$AGENT_ID" "1 + 2. Reply only RESULT=<answer>." "" ""
    assert_success
    RUN_ID="$(jq -er '.runId | select(type == "string" and length > 0)' <<<"$output")"
    THREAD_ID="$(jq -er '.threadId | select(type == "string" and length > 0)' <<<"$output")"
    run runner_wait_for_run "$RUN_ID" 180
    assert_success
    run jq -e '.status == "completed" and (.result.agentSessionId | type == "string" and length > 0)' <<<"$output"
    assert_success
    run _wait_for_runner_chat_output "$THREAD_ID" "$RUN_ID" "RESULT=3" 60
    assert_success

    run runner_api_curl "/api/runs/${RUN_ID}/context"
    assert_success
    run jq -e '
        .cliAgentType == "pi" and
        .environment.OPENAI_BASE_URL == "https://openrouter.ai/api/v1" and
        .environment.OPENAI_MODEL == "@preset/okou-1-0" and
        any(.firewalls[]?;
            .kind == "builtin" and .name == "model-provider:openrouter-codex"
        )
    ' <<<"$output"
    assert_success
}
