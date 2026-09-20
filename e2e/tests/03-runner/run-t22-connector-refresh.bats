#!/usr/bin/env bats

# Connector credential replacement across same-thread continuation.

load '../../helpers/setup'
load '../../helpers/runner-chat'
load '../../helpers/runner-api'

setup() {
    runner_e2e_require_environment
    runner_e2e_setup_test
}

teardown() {
    runner_e2e_teardown_test bentoml
}

assert_no_connector_refresh_raw_secrets() {
    local surfaces="$1"
    shift

    local raw_secret
    for raw_secret in "$@"; do
        if [[ "$surfaces" == *"$raw_secret"* ]]; then
            fail "raw BentoML credential appeared in a public runner surface"
        fi
    done
}

@test "continued runner session refreshes replaced connector credentials" {
    run create_runner_agent "runner-connector-refresh-${TEST_ID}"
    echo "$output"
    assert_success
    AGENT_ID="$output"

    local initial_secret="e2e-bentoml-initial-$(_runner_uuid)"
    local updated_secret="e2e-bentoml-updated-$(_runner_uuid)"
    local initial_endpoint="https://bentoml.com"
    local updated_endpoint="https://cloud.bentoml.com"
    local initial_endpoint_digest updated_endpoint_digest
    initial_endpoint_digest=$(printf '%s' "$initial_endpoint" | sha256sum | cut -d' ' -f1)
    updated_endpoint_digest=$(printf '%s' "$updated_endpoint" | sha256sum | cut -d' ' -f1)

    local values public_surfaces=''
    values=$(jq -nc \
        --arg apiToken "$initial_secret" \
        --arg endpoint "$initial_endpoint" \
        '{apiToken: $apiToken, endpoint: $endpoint}')
    run runner_e2e_connect_manual_connector \
        bentoml \
        api-token \
        "$AGENT_ID" \
        "$values"
    echo "$output"
    assert_success
    CONNECTOR_ACCOUNT_ID=$(jq -er \
        '.id | select(type == "string" and length > 0)' \
        <<<"$output")
    public_surfaces+="$output"$'\n'

    local probe_template
    probe_template=$(cat <<'EOF'
set -euo pipefail
printf 'BENTOML_API_KEY=%s\n' "$BENTO_CLOUD_API_KEY"
printf 'BENTOML_ENDPOINT_SHA256='
printf '%s' "$BENTO_CLOUD_API_ENDPOINT" | sha256sum | cut -d' ' -f1
# Raw DNS has dedicated runner coverage. Keep this connector-refresh probe on
# IPv4 so an unavailable AAAA response cannot block an otherwise valid request.
# Leave room for connection setup around the proxy's 10-second auth deadline.
if curl --ipv4 --silent --show-error --max-time 15 \
    --write-out '__OUTPUT_PREFIX__CURL http_code=%{http_code} namelookup=%{time_namelookup} connect=%{time_connect} appconnect=%{time_appconnect} starttransfer=%{time_starttransfer} total=%{time_total}\n' \
    --output /dev/null \
    "${BENTO_CLOUD_API_ENDPOINT}/"; then
    printf '__OUTPUT_PREFIX__SENT\n'
else
    curl_status=$?
    printf '__OUTPUT_PREFIX__FAILED=%s\n' "$curl_status"
    exit "$curl_status"
fi
EOF
)

    local first_output_prefix="BENTOML_INITIAL_REQUEST_${TEST_ID}_"
    local first_prompt="${probe_template//__OUTPUT_PREFIX__/$first_output_prefix}"
    run runner_e2e_start_chat_run "$AGENT_ID" "$first_prompt"
    echo "$output"
    assert_success
    local first_send_response="$output"
    public_surfaces+="$first_send_response"$'\n'
    local first_run_id
    first_run_id=$(jq -er '.runId | select(type == "string" and length > 0)' \
        <<<"$first_send_response")
    RUN_ID="$first_run_id"
    THREAD_ID=$(jq -er '.threadId | select(type == "string" and length > 0)' \
        <<<"$first_send_response")

    run runner_wait_for_run "$first_run_id" 180
    echo "$output"
    assert_success
    local first_run_response="$output"
    public_surfaces+="$first_run_response"$'\n'
    local first_session_id
    first_session_id=$(jq -er \
        '.result.agentSessionId | select(type == "string" and length > 0)' \
        <<<"$first_run_response")

    # Both outcomes share a prefix so transport failures surface before the
    # firewall-log wait rather than timing out on a success-only marker.
    run runner_e2e_wait_for_chat_text \
        "$THREAD_ID" \
        "$first_run_id" \
        "$first_output_prefix"
    echo "$output"
    assert_success
    local first_agent_text="$output"
    public_surfaces+="$first_agent_text"$'\n'
    if [[ "$first_agent_text" != *"${first_output_prefix}SENT"* ]]; then
        # Network telemetry is uploaded after completion. Collect both public
        # diagnostic surfaces before preserving the original probe assertion.
        run runner_api_curl "/api/runs/${first_run_id}/context"
        local first_context_diagnostics="$output"
        public_surfaces+="$first_context_diagnostics"$'\n'
        run runner_e2e_wait_for_firewall_log \
            "$first_run_id" \
            bentoml \
            bentoml.com \
            '["BENTO_CLOUD_API_KEY"]'
        local first_network_diagnostics="$output"
        public_surfaces+="$first_network_diagnostics"$'\n'
        assert_no_connector_refresh_raw_secrets \
            "$public_surfaces" \
            "$initial_secret" \
            "$updated_secret"
        echo "$first_context_diagnostics"
        echo "$first_network_diagnostics"
        output="$first_agent_text"
    fi
    assert_output --partial "${first_output_prefix}SENT"
    assert_output --partial \
        "BENTOML_API_KEY=cur7hCoffeeSafeLocalCoffeeSafeLocalCoffeeSafe"
    assert_output --partial "BENTOML_ENDPOINT_SHA256=${initial_endpoint_digest}"
    refute_output --partial "BENTOML_ENDPOINT_SHA256=${updated_endpoint_digest}"

    run runner_api_curl "/api/runs/${first_run_id}/context"
    echo "$output"
    assert_success
    public_surfaces+="$output"$'\n'

    run runner_e2e_wait_for_firewall_log \
        "$first_run_id" \
        bentoml \
        bentoml.com \
        '["BENTO_CLOUD_API_KEY"]'
    echo "$output"
    assert_success
    local first_network_logs="$output"
    public_surfaces+="$first_network_logs"$'\n'
    run jq -e --arg unexpectedHost cloud.bentoml.com '
        all(.[];
            .firewall_name != "bentoml" or
            .host != $unexpectedHost
        )
    ' <<<"$first_network_logs"
    echo "$output"
    assert_success

    values=$(jq -nc \
        --arg apiToken "$updated_secret" \
        --arg endpoint "$updated_endpoint" \
        '{apiToken: $apiToken, endpoint: $endpoint}')
    run runner_e2e_connect_manual_connector \
        bentoml \
        api-token \
        "$AGENT_ID" \
        "$values" \
        "$CONNECTOR_ACCOUNT_ID"
    echo "$output"
    assert_success
    public_surfaces+="$output"$'\n'

    local updated_output_prefix="BENTOML_UPDATED_REQUEST_${TEST_ID}_"
    local updated_prompt="${probe_template//__OUTPUT_PREFIX__/$updated_output_prefix}"
    run runner_e2e_continue_chat_run \
        "$AGENT_ID" \
        "$THREAD_ID" \
        "$updated_prompt"
    echo "$output"
    assert_success
    local updated_send_response="$output"
    public_surfaces+="$updated_send_response"$'\n'
    run jq -e --arg threadId "$THREAD_ID" --arg firstRunId "$first_run_id" '
        .threadId == $threadId and
        (.runId | type == "string" and length > 0) and
        .runId != $firstRunId
    ' <<<"$updated_send_response"
    echo "$output"
    assert_success
    RUN_ID=$(jq -er '.runId' <<<"$updated_send_response")

    run runner_wait_for_run "$RUN_ID" 180
    echo "$output"
    assert_success
    local updated_run_response="$output"
    public_surfaces+="$updated_run_response"$'\n'
    local updated_session_id
    updated_session_id=$(jq -er \
        '.result.agentSessionId | select(type == "string" and length > 0)' \
        <<<"$updated_run_response")
    [[ "$updated_session_id" == "$first_session_id" ]]

    run runner_e2e_wait_for_chat_text \
        "$THREAD_ID" \
        "$RUN_ID" \
        "$updated_output_prefix"
    echo "$output"
    assert_success
    local updated_agent_text="$output"
    public_surfaces+="$updated_agent_text"$'\n'
    if [[ "$updated_agent_text" != *"${updated_output_prefix}SENT"* ]]; then
        # Preserve the continued Run's completed public diagnostics before the
        # phase-specific probe assertion reports its original failure.
        run runner_api_curl "/api/runs/${RUN_ID}/context"
        local updated_context_diagnostics="$output"
        public_surfaces+="$updated_context_diagnostics"$'\n'
        run runner_e2e_wait_for_firewall_log \
            "$RUN_ID" \
            bentoml \
            cloud.bentoml.com \
            '["BENTO_CLOUD_API_KEY"]'
        local updated_network_diagnostics="$output"
        public_surfaces+="$updated_network_diagnostics"$'\n'
        assert_no_connector_refresh_raw_secrets \
            "$public_surfaces" \
            "$initial_secret" \
            "$updated_secret"
        echo "$updated_context_diagnostics"
        echo "$updated_network_diagnostics"
        output="$updated_agent_text"
    fi
    assert_output --partial "${updated_output_prefix}SENT"
    assert_output --partial \
        "BENTOML_API_KEY=cur7hCoffeeSafeLocalCoffeeSafeLocalCoffeeSafe"
    assert_output --partial "BENTOML_ENDPOINT_SHA256=${updated_endpoint_digest}"
    refute_output --partial "BENTOML_ENDPOINT_SHA256=${initial_endpoint_digest}"

    run runner_api_curl "/api/runs/${RUN_ID}/context"
    echo "$output"
    assert_success
    public_surfaces+="$output"$'\n'

    run runner_e2e_wait_for_firewall_log \
        "$RUN_ID" \
        bentoml \
        cloud.bentoml.com \
        '["BENTO_CLOUD_API_KEY"]'
    echo "$output"
    assert_success
    local updated_network_logs="$output"
    public_surfaces+="$updated_network_logs"$'\n'
    run jq -e --arg unexpectedHost bentoml.com '
        all(.[];
            .firewall_name != "bentoml" or
            .host != $unexpectedHost
        )
    ' <<<"$updated_network_logs"
    echo "$output"
    assert_success

    run runner_chat_event_rows "$THREAD_ID"
    echo "$output"
    assert_success
    public_surfaces+="$output"$'\n'

    assert_no_connector_refresh_raw_secrets \
        "$public_surfaces" \
        "$initial_secret" \
        "$updated_secret"
}
