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
    runner_e2e_teardown_test zendesk-guide
}

@test "runner firewall resolves the Zendesk Guide variable base and Basic header auth" {
    local subdomain="e2e${RANDOM}${RANDOM}"
    local host="${subdomain}.zendesk.com"
    run create_runner_agent "runner-firewall-zendesk-guide-${TEST_ID}"
    echo "$output"
    assert_success
    AGENT_ID="$output"

    local values
    values=$(jq -nc \
        --arg apiToken "e2e-zendesk-guide-token-${TEST_ID}" \
        --arg basicUsername "runner-e2e@vm0.ai/token" \
        --arg host "$host" \
        '{apiToken: $apiToken, basicUsername: $basicUsername, host: $host}')
    run runner_e2e_connect_manual_connector zendesk-guide api-token-basic "$AGENT_ID" "$values"
    echo "$output"
    assert_success
    CONNECTOR_ACCOUNT_ID=$(jq -er \
        '.id | select(type == "string" and length > 0)' \
        <<<"$output")

    local prompt
    prompt=$(cat <<'EOF'
set -euo pipefail
printf 'ZENDESK_GUIDE_API_TOKEN=%s\n' "$ZENDESK_GUIDE_API_TOKEN"
printf 'ZENDESK_GUIDE_BASIC_USERNAME=%s\n' "$ZENDESK_GUIDE_BASIC_USERNAME"
printf 'ZENDESK_GUIDE_HOST=%s\n' "$ZENDESK_GUIDE_HOST"
# A Zendesk Guide response is outside this test's contract. Keep the request on the
# real IPv4 authority and outlive the proxy's 10-second firewall-auth deadline,
# so auth reaches a decision before this shell can complete the run.
curl_status=0
curl --ipv4 --silent --show-error --max-time 15 \
    --output /dev/null \
    "https://__HOST__/api/v2/help_center/articles" || curl_status=$?
printf 'ZENDESK_GUIDE_REQUEST_SENT=%s\n' "$curl_status"
EOF
)
    prompt="${prompt//__HOST__/$host}"
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
    run runner_e2e_wait_for_chat_text "$THREAD_ID" "$RUN_ID" ZENDESK_GUIDE_REQUEST_SENT
    echo "$output"
    assert_success
    assert_output --partial "ZENDESK_GUIDE_API_TOKEN=CoffeeSafeLocalZendeskGuideApiToken000000000000"
    assert_output --partial "ZENDESK_GUIDE_BASIC_USERNAME=runner-e2e@vm0.ai/token"
    assert_output --partial "ZENDESK_GUIDE_HOST=${host}"

    run runner_e2e_wait_for_firewall_log \
        "$RUN_ID" \
        zendesk-guide \
        "$host" \
        '["ZENDESK_GUIDE_API_TOKEN"]'
    echo "$output"
    assert_success
}
