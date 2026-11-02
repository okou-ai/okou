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
    runner_e2e_teardown_test postmark
}

@test "runner refreshes connector permissions during an active run" {
    run create_runner_agent "runner-firewall-permission-refresh-${TEST_ID}"
    echo "$output"
    assert_success
    AGENT_ID="$output"

    local values
    values=$(jq -nc \
        --arg serverToken "00000000-0000-4000-8000-000000000000" \
        '{serverToken: $serverToken}')
    run runner_e2e_connect_manual_connector postmark server-token "$AGENT_ID" "$values"
    echo "$output"
    assert_success
    CONNECTOR_ACCOUNT_ID=$(jq -er \
        '.connectionId | select(type == "string" and length > 0)' \
        <<<"$output")

    # Raw DNS has dedicated runner coverage. Pin the provider's public sink so
    # this test owns only firewall permission transitions, using a synthetic token.
    local request_url="https://api.postmarkapp.com/templates"
    local checkpoint_script
    checkpoint_script=$(cat <<'EOF'
set -euo pipefail
response_file=$(mktemp)
trap 'rm -f "$response_file"' EXIT
status=$(curl --silent --show-error --max-time 5 \
    --resolve 'api.postmarkapp.com:443:8.8.8.8' \
    --output "$response_file" \
    --write-out '%{http_code}' \
    --request POST \
    --header 'content-type: application/json' \
    --data '{"Name":"vm0-e2e-__TEST_ID__","Subject":"E2E","TextBody":"E2E"}' \
    '__REQUEST_URL__')
test "$status" = 403
grep -Eq '"error"[[:space:]]*:[[:space:]]*"permission_denied"' "$response_file"
printf 'POSTMARK_PERMISSION_DENIED\n'
EOF
)
    checkpoint_script=${checkpoint_script//__REQUEST_URL__/$request_url}
    checkpoint_script=${checkpoint_script//__TEST_ID__/$TEST_ID}

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
        --resolve 'api.postmarkapp.com:443:8.8.8.8' \
        --output "$response_file" \
        --request POST \
        --header 'content-type: application/json' \
        --data '{"Name":"vm0-e2e-__TEST_ID__","Subject":"E2E","TextBody":"E2E"}' \
        '__REQUEST_URL__' &&
        ! grep -Eq '"error"[[:space:]]*:[[:space:]]*"permission_denied"' "$response_file"; then
        printf 'POSTMARK_PERMISSION_ALLOWED\n'
        exit 0
    fi
    sleep 1
done
cat "$response_file" >&2
echo 'Timed out waiting for the Postmark permission refresh' >&2
exit 1
EOF
)
    continuation_script=${continuation_script//__REQUEST_URL__/$request_url}
    continuation_script=${continuation_script//__TEST_ID__/$TEST_ID}

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
        POSTMARK_PERMISSION_DENIED
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
            connectorSlug: "postmark",
            mode: "patch",
            grants: [{
                permission: "templates.manage",
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

    run runner_e2e_wait_for_chat_text "$THREAD_ID" "$RUN_ID" POSTMARK_PERMISSION_ALLOWED
    echo "$output"
    assert_success

    run runner_e2e_wait_for_firewall_transition \
        "$RUN_ID" \
        postmark \
        api.postmarkapp.com \
        POST \
        "$request_url" \
        templates.manage
    echo "$output"
    assert_success
}
