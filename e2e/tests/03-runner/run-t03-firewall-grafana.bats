#!/usr/bin/env bats

load '../../helpers/setup'
load '../../helpers/runner-chat'
load '../../helpers/runner-api'

setup() {
    runner_e2e_use_mock_codex_profile
    runner_e2e_require_environment
    runner_e2e_setup_test
}

teardown() {
    runner_e2e_teardown_test grafana
}

@test "runner firewall resolves the Grafana variable base and header auth" {
    local grafana_host="play.grafana.org"
    run create_runner_agent "runner-firewall-grafana-${TEST_ID}"
    echo "$output"
    assert_success
    AGENT_ID="$output"

    local values
    values=$(jq -nc \
        --arg credential "e2e-grafana-token-${TEST_ID}" \
        --arg instanceHost "$grafana_host" \
        '{credential: $credential, instanceHost: $instanceHost}')
    run runner_e2e_connect_manual_connector \
        grafana \
        service-account-token \
        "$AGENT_ID" \
        "$values"
    echo "$output"
    assert_success
    CONNECTOR_ACCOUNT_ID=$(jq -er \
        '.id | select(type == "string" and length > 0)' \
        <<<"$output")

    local prompt
    prompt=$(cat <<'EOF'
set -euo pipefail
printf 'GRAFANA_SERVICE_ACCOUNT_TOKEN=%s\n' "$GRAFANA_SERVICE_ACCOUNT_TOKEN"
printf 'GRAFANA_HOST=%s\n' "$GRAFANA_HOST"
# A Grafana response is outside this test's contract. Keep the request on the
# real IPv4 authority and outlive the proxy's 10-second firewall-auth deadline,
# so auth reaches a decision before this shell can complete the run.
curl_status=0
curl --ipv4 --silent --show-error --max-time 15 \
    --output /dev/null \
    "https://__HOST__/api/search" || curl_status=$?
printf 'GRAFANA_REQUEST_SENT=%s\n' "$curl_status"
EOF
)
    prompt="${prompt//__HOST__/$grafana_host}"
    run runner_e2e_start_mock_shell_chat_run "$AGENT_ID" "$prompt"
    echo "$output"
    assert_success
    RUN_ID=$(jq -er '.runId | select(type == "string" and length > 0)' <<<"$output")
    THREAD_ID=$(jq -er '.threadId' <<<"$output")

    run runner_wait_for_run "$RUN_ID" 180
    echo "$output"
    assert_success

    # The marker carries the curl status so a transport anomaly stays visible
    # without turning sink reachability into the assertion under test.
    run runner_e2e_wait_for_chat_text "$THREAD_ID" "$RUN_ID" GRAFANA_REQUEST_SENT
    echo "$output"
    assert_success
    # The published synthetic placeholder has a valid token shape. Assemble it
    # from parts so secret scanners do not mistake the fixture for a credential.
    local token_placeholder="glsa_"
    token_placeholder+="iNValIdinValiDinvalidinvalidinva_5b582697"
    assert_output --partial \
        "GRAFANA_SERVICE_ACCOUNT_TOKEN=${token_placeholder}"
    assert_output --partial "GRAFANA_HOST=${grafana_host}"

    run runner_e2e_wait_for_firewall_log \
        "$RUN_ID" \
        grafana \
        "$grafana_host" \
        '["GRAFANA_SERVICE_ACCOUNT_TOKEN"]'
    echo "$output"
    assert_success
}
