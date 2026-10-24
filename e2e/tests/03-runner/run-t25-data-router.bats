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
    runner_e2e_teardown_test
}

@test "sandbox calls Router staging directly with MITM authentication and owned request history" {
    local before_history
    before_history=$(runner_api_curl "/api/data/router/requests")
    jq -e '.requestIds | type == "array"' <<<"$before_history" >/dev/null

    run create_runner_agent "runner-data-router-${TEST_ID}"
    assert_success
    AGENT_ID="$output"

    local prompt
    prompt=$(cat <<'EOF'
set -eu
test -z "${OKOU_DATA_TOKEN-}"
test "${OKOU_DATA_ROUTER_URL}" = 'https://okou-data-router-staging.vm0.workers.dev/mcp'
result=$(mktemp)
trap 'rm -f "$result"' EXIT
# The sandbox supplies no Authorization header. The privileged MITM injects it
# on the direct Router request and registers the trusted Run/request identity.
curl --fail --silent --show-error --max-time 45 \
    --header 'Content-Type: application/json' \
    --header 'Accept: application/json, text/event-stream' \
    --data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"data_capabilities","arguments":{}}}' \
    --output "$result" \
    "$OKOU_DATA_ROUTER_URL"
jq -e '
    .result.isError != true and
    .result.structuredContent.data.status == 200 and
    (.result.structuredContent.data.body.capabilities | length > 0)
' "$result" >/dev/null
printf 'DATA_ROUTER_DIRECT_OK\n'
EOF
)
    run runner_e2e_start_mock_shell_chat_run "$AGENT_ID" "$prompt"
    assert_success
    RUN_ID=$(jq -er '.runId' <<<"$output")
    THREAD_ID=$(jq -er '.threadId' <<<"$output")

    run runner_wait_for_run "$RUN_ID" 180
    assert_success
    run jq -e '.status == "completed"' <<<"$output"
    assert_success

    run runner_e2e_wait_for_chat_text "$THREAD_ID" "$RUN_ID" DATA_ROUTER_DIRECT_OK 30
    assert_success

    run runner_e2e_wait_for_firewall_log \
        "$RUN_ID" \
        data-router \
        okou-data-router-staging.vm0.workers.dev \
        '["OKOU_DATA_TOKEN"]'
    assert_success
    # Unused rewrite metadata is omitted; also verify the actual destination.
    run jq -e 'any(.[];
        .firewall_name == "data-router" and
        .url == "https://okou-data-router-staging.vm0.workers.dev/mcp" and
        .status == 200 and
        .auth_url_rewrite != true
    )' <<<"$output"
    assert_success

    run runner_api_curl "/api/data/router/requests"
    assert_success
    local after_history="$output"
    run jq -e --argjson before "$before_history" '
        (.requestIds - $before.requestIds | length) >= 1
    ' <<<"$after_history"
    assert_success
}
