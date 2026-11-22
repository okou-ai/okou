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
    runner_e2e_teardown_test strapi
}

@test "runner firewall resolves the Strapi variable base and header auth" {
    # The custom connector account fixture uses example.com in the same workspace.
    local strapi_host="example.org"
    local strapi_base_url="https://${strapi_host}"
    local values
    values=$(jq -nc \
        --arg apiToken "e2e-strapi-token-${TEST_ID}" \
        --arg baseUrl "$strapi_base_url" \
        '{apiToken: $apiToken, baseUrl: $baseUrl}')
    run runner_e2e_connect_manual_connector \
        strapi \
        api-token \
        "$values"
    echo "$output"
    assert_success
    CONNECTOR_ACCOUNT_ID=$(jq -er \
        '.connectionId | select(type == "string" and length > 0)' \
        <<<"$output")

    local prompt
    prompt=$(cat <<'EOF'
set -euo pipefail
printf 'STRAPI_TOKEN=%s\n' "$STRAPI_TOKEN"
printf 'STRAPI_BASE_URL=%s\n' "$STRAPI_BASE_URL"
# The configured public documentation host is a sink, not a Strapi deployment.
# Its response is outside this test's contract. Use IPv4 and outlive the proxy's
# 10-second firewall-auth deadline before this shell can complete the run.
curl_status=0
curl --ipv4 --silent --show-error --max-time 15 \
    --output /dev/null \
    "${STRAPI_BASE_URL}/api/e2e" || curl_status=$?
printf 'STRAPI_REQUEST_SENT=%s\n' "$curl_status"
EOF
)
    run runner_e2e_start_mock_shell_chat_run "$prompt"
    echo "$output"
    assert_success
    RUN_ID=$(jq -er '.runId | select(type == "string" and length > 0)' <<<"$output")
    THREAD_ID=$(jq -er '.threadId' <<<"$output")

    run runner_wait_for_run "$RUN_ID" 180
    echo "$output"
    assert_success

    # The marker carries the curl status so a transport anomaly stays visible
    # without turning sink reachability into the assertion under test.
    run runner_e2e_wait_for_chat_text "$THREAD_ID" "$RUN_ID" STRAPI_REQUEST_SENT
    echo "$output"
    assert_success
    assert_output --partial \
        "STRAPI_TOKEN=CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLo"
    assert_output --partial "STRAPI_BASE_URL=${strapi_base_url}"

    run runner_e2e_wait_for_firewall_log \
        "$RUN_ID" \
        strapi \
        "$strapi_host" \
        '["STRAPI_TOKEN"]'
    echo "$output"
    assert_success

    jq -e --arg host "$strapi_host" --arg url "${strapi_base_url}/api/e2e" '
        any(.[];
            .firewall_name == "strapi" and
            .host == $host and
            .method == "GET" and
            .url == $url and
            .action == "ALLOW" and
            (.firewall_error // null) == null and
            .auth_resolved_secrets == ["STRAPI_TOKEN"])
    ' <<<"$output"
}
