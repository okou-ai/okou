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
    runner_e2e_teardown_test meilisearch
}

@test "runner refreshes connector permissions during an active run" {
    run create_runner_agent "runner-firewall-permission-refresh-${TEST_ID}"
    echo "$output"
    assert_success
    AGENT_ID="$output"

    local values
    values=$(jq -nc \
        --arg instanceUrl "https://firewall-placeholder.vm3.ai/meilisearch" \
        --arg apiKey "00000000000000000000000000000000" \
        '{instanceUrl: $instanceUrl, apiKey: $apiKey}')
    run runner_e2e_connect_manual_connector meilisearch api-key "$AGENT_ID" "$values"
    echo "$output"
    assert_success
    CONNECTOR_ACCOUNT_ID=$(jq -er \
        '.connectionId | select(type == "string" and length > 0)' \
        <<<"$output")

    # Raw DNS has dedicated runner coverage. Pin the synthetic placeholder's
    # public sink so this test owns only firewall permission transitions.
    local request_url="https://firewall-placeholder.vm3.ai/meilisearch/indexes/vm0-e2e-${TEST_ID}/documents"
    local checkpoint_script
    checkpoint_script=$(cat <<'EOF'
set -euo pipefail
response_file=$(mktemp)
trap 'rm -f "$response_file"' EXIT
status=$(curl --silent --show-error --max-time 5 \
    --resolve 'firewall-placeholder.vm3.ai:443:8.8.8.8' \
    --output "$response_file" \
    --write-out '%{http_code}' \
    --request POST \
    --header 'content-type: application/json' \
    --data '[{"id":"vm0-e2e"}]' \
    '__REQUEST_URL__')
test "$status" = 403
grep -Eq '"error"[[:space:]]*:[[:space:]]*"permission_denied"' "$response_file"
printf 'MEILISEARCH_PERMISSION_DENIED\n'
EOF
)
    checkpoint_script=${checkpoint_script//__REQUEST_URL__/$request_url}

    local continuation_script
    continuation_script=$(cat <<'EOF'
set -euo pipefail
response_file=$(mktemp)
trap 'rm -f "$response_file"' EXIT
deadline=$((SECONDS + 90))
while ((SECONDS < deadline)); do
    : > "$response_file"
    # The allowed request can spend up to 10 seconds resolving auth. A transport
    # failure or partial response must not end the run before policy is observed.
    if curl --silent --show-error --max-time 15 \
        --resolve 'firewall-placeholder.vm3.ai:443:8.8.8.8' \
        --output "$response_file" \
        --request POST \
        --header 'content-type: application/json' \
        --data '[{"id":"vm0-e2e"}]' \
        '__REQUEST_URL__' &&
        ! grep -Eq '"error"[[:space:]]*:[[:space:]]*"permission_denied"' "$response_file"; then
        printf 'MEILISEARCH_PERMISSION_ALLOWED\n'
        exit 0
    fi
    sleep 1
done
cat "$response_file" >&2
echo 'Timed out waiting for the Meilisearch permission refresh' >&2
exit 1
EOF
)
    continuation_script=${continuation_script//__REQUEST_URL__/$request_url}

    run runner_e2e_start_mock_checkpointed_chat_run \
        "$AGENT_ID" \
        "$checkpoint_script" \
        "$continuation_script"
    echo "$output"
    assert_success
    RUN_ID=$(jq -er '.runId | select(type == "string" and length > 0)' <<<"$output")
    THREAD_ID=$(jq -er '.threadId | select(type == "string" and length > 0)' <<<"$output")

    run runner_e2e_wait_for_active_chat_text \
        "$THREAD_ID" \
        "$RUN_ID" \
        MEILISEARCH_PERMISSION_DENIED
    echo "$output"
    assert_success

    run runner_api_curl "/api/runs/${RUN_ID}"
    echo "$output"
    assert_success
    run jq -e '.status == "running"' <<<"$output"
    echo "$output"
    assert_success

    local grant_payload
    grant_payload=$(jq -nc \
        --arg agentId "$AGENT_ID" \
        '{
            agentId: $agentId,
            connectorSlug: "meilisearch",
            mode: "patch",
            grants: [{
                permission: "documents.write",
                action: "allow",
                expiresIn: "1h"
            }]
        }')
    run runner_api_curl "/api/user-permission-grants/apply" \
        -X PUT \
        -d "$grant_payload"
    echo "$output"
    assert_success

    run runner_wait_for_run "$RUN_ID" 180
    echo "$output"
    assert_success

    run runner_e2e_wait_for_chat_text "$THREAD_ID" "$RUN_ID" MEILISEARCH_PERMISSION_ALLOWED
    echo "$output"
    assert_success

    run runner_e2e_wait_for_firewall_transition \
        "$RUN_ID" \
        meilisearch \
        firewall-placeholder.vm3.ai \
        POST \
        "$request_url" \
        documents.write
    echo "$output"
    assert_success
}
