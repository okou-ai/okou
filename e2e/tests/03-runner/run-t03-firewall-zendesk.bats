#!/usr/bin/env bats

load '../../helpers/setup'
load '../../helpers/runner-chat'
load '../../helpers/runner-api'

setup() {
    runner_e2e_use_native_codex_account
    runner_e2e_require_environment
    runner_e2e_setup_test
}

teardown() {
    runner_e2e_teardown_test zendesk
}

@test "runner firewall resolves the Zendesk variable base and header auth" {
    local subdomain="e2e${RANDOM}${RANDOM}"
    run create_runner_agent "runner-firewall-zendesk-${TEST_ID}"
    echo "$output"
    assert_success
    AGENT_ID="$output"

    local values
    values=$(jq -nc \
        --arg apiToken "e2e-zendesk-token-${TEST_ID}" \
        --arg email "runner-e2e@vm0.ai" \
        --arg subdomain "$subdomain" \
        '{apiToken: $apiToken, email: $email, subdomain: $subdomain}')
    run runner_e2e_connect_manual_connector zendesk api-token "$AGENT_ID" "$values"
    echo "$output"
    assert_success
    CONNECTOR_ACCOUNT_ID=$(jq -er \
        '.id | select(type == "string" and length > 0)' \
        <<<"$output")

    local prompt
    prompt=$(cat <<'EOF'
set -euo pipefail
printf 'ZENDESK_API_TOKEN=%s\n' "$ZENDESK_API_TOKEN"
printf 'ZENDESK_EMAIL=%s\n' "$ZENDESK_EMAIL"
printf 'ZENDESK_SUBDOMAIN=%s\n' "$ZENDESK_SUBDOMAIN"
# A Zendesk response is outside this test's contract. Keep the request on the
# real IPv4 authority and outlive the proxy's 10-second firewall-auth deadline,
# so auth reaches a decision before this shell can complete the run.
curl_status=0
curl --ipv4 --silent --show-error --max-time 15 \
    --output /dev/null \
    "https://__SUBDOMAIN__.zendesk.com/api/v2/users/me.json" || curl_status=$?
printf 'ZENDESK_REQUEST_SENT=%s\n' "$curl_status"
EOF
)
    prompt="${prompt//__SUBDOMAIN__/$subdomain}"
    run runner_e2e_start_chat_run "$AGENT_ID" "$prompt"
    echo "$output"
    assert_success
    RUN_ID=$(jq -er '.runId | select(type == "string" and length > 0)' <<<"$output")
    THREAD_ID=$(jq -er '.threadId' <<<"$output")

    run runner_wait_for_run "$RUN_ID" 180
    echo "$output"
    assert_success

    # The marker carries the curl status so a transport anomaly stays visible
    # without turning sink reachability into the assertion under test.
    run runner_e2e_wait_for_chat_text "$THREAD_ID" "$RUN_ID" ZENDESK_REQUEST_SENT
    echo "$output"
    assert_success
    assert_output --partial "ZENDESK_API_TOKEN=zkTkn_CoffeeSafeLocalCoffeeSafeLocalCoffeeSa"
    assert_output --partial "ZENDESK_EMAIL=runner-e2e@vm0.ai"
    assert_output --partial "ZENDESK_SUBDOMAIN=${subdomain}"

    run runner_e2e_wait_for_firewall_log \
        "$RUN_ID" \
        zendesk \
        "${subdomain}.zendesk.com" \
        '["ZENDESK_API_TOKEN"]'
    echo "$output"
    assert_success
}
