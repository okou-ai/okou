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

@test "sandbox calls Router staging and lists owned jobs with MITM authentication" {
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
catalog=$(mktemp)
trap 'rm -f "$result" "$catalog"' EXIT
# The sandbox supplies no Authorization header. The privileged MITM injects it
# on the direct Router request. Router serves only stateless 2026-07-28 MCP
# requests with JSON responses.
curl --fail --silent --show-error --max-time 45 \
    --header 'Content-Type: application/json' \
    --header 'Accept: application/json' \
    --header 'MCP-Protocol-Version: 2026-07-28' \
    --header 'Mcp-Method: tools/list' \
    --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}' \
    --output "$catalog" \
    "$OKOU_DATA_ROUTER_URL"
jq -e '[.result.tools[] | select(._meta["ai.okou/data"])] | length > 0' "$catalog" >/dev/null
okou data tools --json >"$result"
tool=$(jq -er '.tools[0].name' "$result")
okou data describe "$tool" --json >"$result"
jq -e '.inputSchema.type == "object"' "$result" >/dev/null
# Discover history tools from Router metadata. Each installed CLI call supplies
# caller-owned request IDs using the Run token, without creating paid work.
history_tools=$(jq -er '[.result.tools[] | select(._meta["ai.okou/data"].requestHistory == true) | .name] | select(length > 0) | .[]' "$catalog")
for tool in $history_tools; do
    okou data call "$tool" --input '{"limit":1}' --json >"$result"
    jq -e 'type == "object"' "$result" >/dev/null
done
# A required input rejected by MCP must remain a readable error, rather than
# being mistaken for a lost paid response. Discover the schema instead of
# maintaining a tool-specific argument list in the CLI test.
required_tool=$(jq -er '[.result.tools[] | select(._meta["ai.okou/data"] and ((.inputSchema.required // []) | length > 0))] | .[0].name' "$catalog")
if okou data call "$required_tool" --input '{}' --json >"$result"; then
    exit 1
fi
jq -e '.isError == true and any(.content[]; .type == "text" and (.text | length > 0))' "$result" >/dev/null
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
