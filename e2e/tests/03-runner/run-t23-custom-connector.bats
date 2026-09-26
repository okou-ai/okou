#!/usr/bin/env bats

load '../../helpers/setup'
load '../../helpers/runner-chat'
load '../../helpers/runner-api'

setup() {
    # Keep firewall/account assertions independent of real LLM shell decisions.
    runner_e2e_use_native_codex_account
    runner_e2e_require_environment
    runner_e2e_setup_test
    CUSTOM_CONNECTOR_ID=""
}

teardown() {
    runner_e2e_teardown_test
    if [[ -n "${CUSTOM_CONNECTOR_ID:-}" ]]; then
        runner_api_curl "/api/custom-connectors/${CUSTOM_CONNECTOR_ID}" \
            -X DELETE \
            >/dev/null 2>&1 || true
    fi
}

@test "runner resolves custom connector credentials for an outbound request" {
    run create_runner_agent "runner-custom-connector-${TEST_ID}"
    echo "$output"
    assert_success
    AGENT_ID="$output"

    local connector_slug="_runner-probe-${TEST_ID}"
    local connector_payload
    connector_payload=$(jq -nc \
        --arg slug "$connector_slug" \
        --arg prefix "https://www.google.com/" \
        '{
            slug: $slug,
            kind: "http",
            displayName: "Runner Credential Probe",
            prefixTemplates: [$prefix],
            fields: [{
                key: "probe_secret",
                label: "Probe secret",
                kind: "secret",
                required: true
            }],
            headerInjections: [{
                name: "X-Okou-Custom-Connector-Probe",
                valueTemplate: "{{secrets.probe_secret}}"
            }],
            queryInjections: [],
            authMode: "manual"
        }')
    run runner_api_curl "/api/custom-connectors" \
        -X POST \
        -d "$connector_payload"
    echo "$output"
    assert_success
    CUSTOM_CONNECTOR_ID=$(jq -er \
        '.id | select(type == "string" and length > 0)' \
        <<<"$output")

    local probe_secret
    probe_secret="e2e-custom-connector-$(_runner_uuid)"
    local values_payload
    values_payload=$(jq -nc \
        --arg secret "$probe_secret" \
        '{
            account: {intent: "add"},
            values: [{key: "probe_secret", kind: "secret", value: $secret}]
        }')
    run runner_api_curl \
        "/api/custom-connectors/${CUSTOM_CONNECTOR_ID}/values" \
        -X PUT \
        -d "$values_payload"
    assert_success
    run jq -e '
        .connected == true and
        .missingRequiredFields == [] and
        .configuredFieldKeys == ["probe_secret"]
    ' <<<"$output"
    assert_success

    local grants_payload
    grants_payload=$(jq -nc \
        --arg customConnectorId "$CUSTOM_CONNECTOR_ID" \
        '{
            operation: "replace",
            grants: [{
                customConnectorId: $customConnectorId,
                permissionNames: []
            }]
        }')
    run runner_api_curl "/api/agents/${AGENT_ID}/custom-connectors" \
        -X PUT \
        -d "$grants_payload"
    echo "$output"
    assert_success
    run jq -e \
        --arg customConnectorId "$CUSTOM_CONNECTOR_ID" '
            .grants == [{
                customConnectorId: $customConnectorId,
                permissionNames: []
            }]
        ' <<<"$output"
    assert_success

    local prompt
    prompt=$(cat <<'EOF'
set -euo pipefail
# Leave room for connection setup around the proxy's 10-second auth deadline.
curl --silent --show-error --max-time 15 \
    --output /dev/null \
    'https://www.google.com/robots.txt' || true
printf 'CUSTOM_CONNECTOR_REQUEST_SENT\n'
EOF
)

    run runner_e2e_start_chat_run "$AGENT_ID" "$prompt"
    echo "$output"
    assert_success
    RUN_ID=$(jq -er \
        '.runId | select(type == "string" and length > 0)' \
        <<<"$output")
    THREAD_ID=$(jq -er \
        '.threadId | select(type == "string" and length > 0)' \
        <<<"$output")

    run runner_wait_for_run "$RUN_ID" 180
    echo "$output"
    assert_success

    run runner_e2e_wait_for_chat_text \
        "$THREAD_ID" \
        "$RUN_ID" \
        CUSTOM_CONNECTOR_REQUEST_SENT
    echo "$output"
    assert_success

    local compact_connector_id="${CUSTOM_CONNECTOR_ID//-/}"
    local firewall_name="custom_connector_${compact_connector_id}"
    local secret_key="CUSTOM_${compact_connector_id}_S_PROBE_SECRET"
    local expected_secrets
    expected_secrets=$(jq -nc --arg secretKey "$secret_key" '[$secretKey]')
    run runner_e2e_wait_for_firewall_log \
        "$RUN_ID" \
        "$firewall_name" \
        www.google.com \
        "$expected_secrets"
    echo "$output"
    assert_success
}

@test "runner resolves an exact custom connector account on thread continuation" {
    run create_runner_agent "runner-custom-connector-account-${TEST_ID}"
    echo "$output"
    assert_success
    AGENT_ID="$output"

    local connector_slug="_runner-account-probe-${TEST_ID}"
    local connector_payload
    connector_payload=$(jq -nc \
        --arg slug "$connector_slug" \
        --arg prefix 'https://{{variables.host}}/' \
        '{
            slug: $slug,
            kind: "http",
            displayName: "Runner Account Probe",
            prefixTemplates: [$prefix],
            fields: [
                {
                    key: "probe_secret",
                    label: "Probe secret",
                    kind: "secret",
                    required: true
                },
                {
                    key: "host",
                    label: "Host",
                    kind: "variable",
                    required: true
                }
            ],
            headerInjections: [{
                name: "X-Okou-Custom-Connector-Account-Probe",
                valueTemplate: "{{secrets.probe_secret}}"
            }],
            queryInjections: [],
            authMode: "manual"
        }')
    run runner_api_curl "/api/custom-connectors" \
        -X POST \
        -d "$connector_payload"
    echo "$output"
    assert_success
    local public_surfaces="$output"$'\n'
    CUSTOM_CONNECTOR_ID=$(jq -er \
        '.id | select(type == "string" and length > 0)' \
        <<<"$output")

    local default_secret selected_secret
    default_secret="e2e-custom-default-$(_runner_uuid)"
    selected_secret="e2e-custom-selected-$(_runner_uuid)"

    local default_values_payload
    default_values_payload=$(jq -nc \
        --arg secret "$default_secret" \
        '{
            account: {intent: "add", displayName: "Default account"},
            values: [
                {key: "probe_secret", kind: "secret", value: $secret},
                {key: "host", kind: "variable", value: "example.com"}
            ]
        }')
    run runner_api_curl \
        "/api/custom-connectors/${CUSTOM_CONNECTOR_ID}/values" \
        -X PUT \
        -d "$default_values_payload"
    echo "$output"
    assert_success
    local default_account_response="$output"
    public_surfaces+="$default_account_response"$'\n'
    local default_connection_id
    default_connection_id=$(jq -er \
        '.connectedAccountId | select(type == "string" and length > 0)' \
        <<<"$default_account_response")
    run jq -e '
        .connected == true and
        .missingRequiredFields == [] and
        (.configuredFieldKeys | sort) == ["host", "probe_secret"]
    ' <<<"$default_account_response"
    assert_success

    local selected_values_payload
    selected_values_payload=$(jq -nc \
        --arg secret "$selected_secret" \
        '{
            account: {intent: "add", displayName: "Selected account"},
            values: [
                {key: "probe_secret", kind: "secret", value: $secret},
                {key: "host", kind: "variable", value: "www.google.com"}
            ]
        }')
    run runner_api_curl \
        "/api/custom-connectors/${CUSTOM_CONNECTOR_ID}/values" \
        -X PUT \
        -d "$selected_values_payload"
    echo "$output"
    assert_success
    local selected_account_response="$output"
    public_surfaces+="$selected_account_response"$'\n'
    local selected_connection_id
    selected_connection_id=$(jq -er \
        '.connectedAccountId | select(type == "string" and length > 0)' \
        <<<"$selected_account_response")
    [[ "$selected_connection_id" != "$default_connection_id" ]]

    run runner_api_curl \
        "/api/connector-accounts/connections?kind=custom&customConnectorId=${CUSTOM_CONNECTOR_ID}&limit=100"
    echo "$output"
    assert_success
    local accounts_response="$output"
    public_surfaces+="$accounts_response"$'\n'
    run jq -e \
        --arg customConnectorId "$CUSTOM_CONNECTOR_ID" \
        --arg defaultConnectionId "$default_connection_id" \
        --arg selectedConnectionId "$selected_connection_id" '
            .nextCursor == null and
            (.connections | length) == 2 and
            any(.connections[];
                .id == $defaultConnectionId and
                .target == {
                    kind: "custom",
                    customConnectorId: $customConnectorId
                } and
                .displayName == "Default account" and
                .isDefault == true and
                .connectionStatus == "connected"
            ) and
            any(.connections[];
                .id == $selectedConnectionId and
                .target == {
                    kind: "custom",
                    customConnectorId: $customConnectorId
                } and
                .displayName == "Selected account" and
                .isDefault == false and
                .connectionStatus == "connected"
            )
        ' <<<"$accounts_response"
    echo "$output"
    assert_success

    local grants_payload
    grants_payload=$(jq -nc \
        --arg customConnectorId "$CUSTOM_CONNECTOR_ID" \
        '{
            operation: "replace",
            grants: [{
                customConnectorId: $customConnectorId,
                permissionNames: []
            }]
        }')
    run runner_api_curl "/api/agents/${AGENT_ID}/custom-connectors" \
        -X PUT \
        -d "$grants_payload"
    echo "$output"
    assert_success
    local grants_response="$output"
    public_surfaces+="$grants_response"$'\n'

    local default_marker="CUSTOM_CONNECTOR_DEFAULT_ACCOUNT_${TEST_ID}"
    local default_prompt
    default_prompt=$(cat <<EOF
set -euo pipefail
# Leave room for connection setup around the proxy's 10-second auth deadline.
curl --silent --show-error --max-time 15 \\
    --output /dev/null \\
    'https://example.com/'
printf '${default_marker}\\n'
EOF
)
    run runner_e2e_start_chat_run "$AGENT_ID" "$default_prompt"
    echo "$output"
    assert_success
    local first_send_response="$output"
    public_surfaces+="$first_send_response"$'\n'
    local first_run_id
    first_run_id=$(jq -er \
        '.runId | select(type == "string" and length > 0)' \
        <<<"$first_send_response")
    RUN_ID="$first_run_id"
    THREAD_ID=$(jq -er \
        '.threadId | select(type == "string" and length > 0)' \
        <<<"$first_send_response")

    run runner_wait_for_run "$first_run_id" 180
    echo "$output"
    assert_success
    public_surfaces+="$output"$'\n'

    run runner_e2e_wait_for_chat_text \
        "$THREAD_ID" \
        "$first_run_id" \
        "$default_marker"
    echo "$output"
    assert_success
    public_surfaces+="$output"$'\n'

    run runner_api_curl "/api/runs/${first_run_id}/context"
    echo "$output"
    assert_success
    local default_run_context="$output"
    public_surfaces+="$default_run_context"$'\n'
    run jq -e \
        --arg customConnectorId "$CUSTOM_CONNECTOR_ID" \
        --arg sourceId "$default_connection_id" '
            ([
                .firewalls[]?
                | select(
                    .kind == "inline" and
                    .customConnectorId == $customConnectorId
                )
            ]) as $matches
            | ($matches | length) == 1 and
                $matches[0].sourceId == $sourceId
        ' <<<"$default_run_context"
    echo "$output"
    assert_success

    local compact_connector_id="${CUSTOM_CONNECTOR_ID//-/}"
    local firewall_name="custom_connector_${compact_connector_id}"
    local secret_key="CUSTOM_${compact_connector_id}_S_PROBE_SECRET"
    local expected_secrets
    expected_secrets=$(jq -nc --arg secretKey "$secret_key" '[$secretKey]')
    run runner_e2e_wait_for_firewall_log \
        "$first_run_id" \
        "$firewall_name" \
        example.com \
        "$expected_secrets"
    echo "$output"
    assert_success
    local default_network_logs="$output"
    public_surfaces+="$default_network_logs"$'\n'
    run jq -e --arg firewallName "$firewall_name" '
        all(.[];
            .firewall_name != $firewallName or
            .host != "www.google.com"
        )
    ' <<<"$default_network_logs"
    echo "$output"
    assert_success

    local selection_payload
    selection_payload=$(jq -nc \
        --arg connectionId "$selected_connection_id" \
        --arg customConnectorId "$CUSTOM_CONNECTOR_ID" \
        '{
            connectionId: $connectionId,
            target: {
                kind: "custom",
                customConnectorId: $customConnectorId
            }
        }')
    run runner_api_curl \
        "/api/chat-threads/${THREAD_ID}/connector-selections" \
        -X PUT \
        -d "$selection_payload"
    echo "$output"
    assert_success
    local selection_response="$output"
    public_surfaces+="$selection_response"$'\n'
    run jq -e \
        --arg connectionId "$selected_connection_id" \
        --arg customConnectorId "$CUSTOM_CONNECTOR_ID" '
            . == {
                connectionId: $connectionId,
                target: {
                    kind: "custom",
                    customConnectorId: $customConnectorId
                }
            }
        ' <<<"$selection_response"
    echo "$output"
    assert_success

    run runner_api_curl \
        "/api/chat-threads/${THREAD_ID}/connector-selections"
    echo "$output"
    assert_success
    local selection_read_response="$output"
    public_surfaces+="$selection_read_response"$'\n'
    run jq -e \
        --arg connectionId "$selected_connection_id" \
        --arg customConnectorId "$CUSTOM_CONNECTOR_ID" '
            .selections == [{
                connectionId: $connectionId,
                target: {
                    kind: "custom",
                    customConnectorId: $customConnectorId
                }
            }] and
            (.selectedConnections | length) == 1 and
            .selectedConnections[0].id == $connectionId and
            .selectedConnections[0].isDefault == false
        ' <<<"$selection_read_response"
    echo "$output"
    assert_success

    local selected_marker="CUSTOM_CONNECTOR_SELECTED_ACCOUNT_${TEST_ID}"
    local selected_prompt
    selected_prompt=$(cat <<EOF
set -euo pipefail
# Leave room for connection setup around the proxy's 10-second auth deadline.
curl --silent --show-error --max-time 15 \\
    --output /dev/null \\
    'https://www.google.com/robots.txt'
printf '${selected_marker}\\n'
EOF
)
    run runner_e2e_continue_chat_run \
        "$AGENT_ID" \
        "$THREAD_ID" \
        "$selected_prompt"
    echo "$output"
    assert_success
    local selected_send_response="$output"
    public_surfaces+="$selected_send_response"$'\n'
    run jq -e \
        --arg threadId "$THREAD_ID" \
        --arg firstRunId "$first_run_id" '
            .threadId == $threadId and
            (.runId | type == "string" and length > 0) and
            .runId != $firstRunId
        ' <<<"$selected_send_response"
    echo "$output"
    assert_success
    RUN_ID=$(jq -er '.runId' <<<"$selected_send_response")

    run runner_wait_for_run "$RUN_ID" 180
    echo "$output"
    assert_success
    public_surfaces+="$output"$'\n'

    run runner_e2e_wait_for_chat_text \
        "$THREAD_ID" \
        "$RUN_ID" \
        "$selected_marker"
    echo "$output"
    assert_success
    public_surfaces+="$output"$'\n'

    run runner_api_curl "/api/runs/${RUN_ID}/context"
    echo "$output"
    assert_success
    local selected_run_context="$output"
    public_surfaces+="$selected_run_context"$'\n'
    run jq -e \
        --arg customConnectorId "$CUSTOM_CONNECTOR_ID" \
        --arg sourceId "$selected_connection_id" '
            ([
                .firewalls[]?
                | select(
                    .kind == "inline" and
                    .customConnectorId == $customConnectorId
                )
            ]) as $matches
            | ($matches | length) == 1 and
                $matches[0].sourceId == $sourceId
        ' <<<"$selected_run_context"
    echo "$output"
    assert_success

    run runner_e2e_wait_for_firewall_log \
        "$RUN_ID" \
        "$firewall_name" \
        www.google.com \
        "$expected_secrets"
    echo "$output"
    assert_success
    local selected_network_logs="$output"
    public_surfaces+="$selected_network_logs"$'\n'
    run jq -e --arg firewallName "$firewall_name" '
        all(.[];
            .firewall_name != $firewallName or
            .host != "example.com"
        )
    ' <<<"$selected_network_logs"
    echo "$output"
    assert_success

    run runner_chat_event_rows "$THREAD_ID"
    echo "$output"
    assert_success
    public_surfaces+="$output"$'\n'

    local raw_secret
    for raw_secret in "$default_secret" "$selected_secret"; do
        if [[ "$public_surfaces" == *"$raw_secret"* ]]; then
            fail "raw custom connector credential appeared in a public runner surface"
        fi
    done
}
