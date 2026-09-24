#!/usr/bin/env bats

# Deliberately outside 03-runner: this paid test requires environment approval.
load '../../helpers/setup'
load '../../helpers/runner-chat'
load '../../helpers/runner-api'

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

configure_codex_oauth() {
    if [[ -z "${CODEX_OAUTH_E2E_AUTH_JSON:-}" ]]; then
        echo "Codex OAuth E2E credential is missing: configure CODEX_OAUTH_E2E_AUTH_JSON" >&2
        return 1
    fi
    if ! jq -e '
        .tokens.access_token | type == "string" and length > 0
    ' <<<"$CODEX_OAUTH_E2E_AUTH_JSON" >/dev/null 2>&1 ||
        ! jq -e '
            .tokens.refresh_token | type == "string" and length > 0
        ' <<<"$CODEX_OAUTH_E2E_AUTH_JSON" >/dev/null 2>&1; then
        echo "Codex OAuth E2E credential is not a complete auth.json; reseed the repository Secret" >&2
        return 1
    fi

    local payload response error_code
    payload="$(printf '%s' "$CODEX_OAUTH_E2E_AUTH_JSON" | jq -Rs '
        {type: "codex-oauth-token", authMethod: "auth_json", secrets: {CODEX_AUTH_JSON: .}}
    ')" || return 1
    if ! response="$(printf '%s' "$payload" | runner_api_curl "/api/me/model-providers" \
        -X POST --data-binary @- 2>/dev/null)"; then
        error_code="$(jq -r '.error.code // "HTTP_ERROR"' <<<"$response" 2>/dev/null)"
        echo "Codex OAuth E2E credential connection failed ($error_code); check or reseed the Secret" >&2
        return 1
    fi
    if ! jq -e '
        .provider.type == "codex-oauth-token" and
        .provider.authMethod == "auth_json" and
        .provider.needsReconnect == false
    ' <<<"$response" >/dev/null; then
        echo "Codex OAuth E2E credential connection did not yield a usable provider" >&2
        return 1
    fi

    local policies policy_payload
    policies="$(runner_api_curl "/api/model-policies")" || return 1
    if ! jq -e 'any(.policies[]?; .model == "gpt-5.6-luna")' \
        <<<"$policies" >/dev/null; then
        echo "Codex OAuth E2E model policy does not contain gpt-5.6-luna" >&2
        return 1
    fi
    policy_payload="$(jq -c '
        {
            revision,
            policies: [.policies[] | {
                model, isDefault, defaultProviderType,
                credentialScope, modelProviderId
            } | if .model == "gpt-5.6-luna" then . + {
                defaultProviderType: "codex-oauth-token",
                credentialScope: "member",
                modelProviderId: null
            } else . end]
        }
    ' <<<"$policies")" || return 1
    if ! runner_api_curl "/api/model-policies" \
        -X PUT -d "$policy_payload" >/dev/null; then
        echo "Codex OAuth E2E failed to select member-scoped model policy" >&2
        return 1
    fi
    policies="$(runner_api_curl "/api/model-policies")" || return 1
    jq -e '
        any(.policies[]?;
            .model == "gpt-5.6-luna" and
            .defaultProviderType == "codex-oauth-token" and
            .credentialScope == "member" and
            .modelProviderId == null
        )
    ' <<<"$policies" >/dev/null
}

@test "real Codex OAuth completes a Luna chat on the candidate runner" {
    configure_codex_oauth

    run create_runner_agent "e2e-codex-oauth-${TEST_ID}"
    assert_success
    AGENT_ID="$output"

    run set_runner_agent_instructions \
        "$AGENT_ID" \
        "Answer the user's prompt briefly."
    assert_success

    run runner_chat_send \
        "$AGENT_ID" \
        "Reply with a short confirmation that you can respond." \
        "" \
        "gpt-5.6-luna"
    assert_success
    RUN_ID="$(jq -er '.runId | select(type == "string" and length > 0)' <<<"$output")"
    THREAD_ID="$(jq -er '.threadId | select(type == "string" and length > 0)' <<<"$output")"

    local run_response
    if ! run_response="$(runner_wait_for_run "$RUN_ID" 180 2>/dev/null)"; then
        local provider_state run_state run_status
        provider_state="$(runner_api_curl "/api/me/model-providers" 2>/dev/null)" || provider_state='{}'
        run_state="$(runner_api_curl "/api/runs/$RUN_ID" 2>/dev/null)" || run_state='{}'
        run_status="$(jq -r '.status // "unavailable"' <<<"$run_state" 2>/dev/null)"
        if jq -e '
            any(.modelProviders[]?;
                .type == "codex-oauth-token" and .needsReconnect == true
            )
        ' <<<"$provider_state" >/dev/null 2>&1; then
            echo "Codex OAuth E2E credential needs reconnection after run status $run_status; reseed the repository Secret" >&2
        else
            echo "Codex OAuth E2E candidate run reached status $run_status after provider connection; inspect runner logs and verify token freshness" >&2
        fi
        return 1
    fi
    if ! jq -e '
        .status == "completed" and
        .source.providerType == "codex-oauth-token" and
        .source.credentialScope == "member" and
        .source.model == "gpt-5.6-luna" and
        (.result.agentSessionId | type == "string" and length > 0)
    ' <<<"$run_response" >/dev/null; then
        echo "Codex OAuth E2E run completed without the required OAuth source" >&2
        return 1
    fi

    run _wait_for_runner_chat_completion "$THREAD_ID" "$RUN_ID" 60
    assert_success
    [[ -n "$output" ]]
}
