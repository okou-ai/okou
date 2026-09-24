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
    runner_e2e_teardown_test discord-webhook
}

@test "runner firewall rewrites the Discord Webhook auth.base placeholder" {
    run create_runner_agent "runner-firewall-discord-${TEST_ID}"
    echo "$output"
    assert_success
    AGENT_ID="$output"

    local values
    values=$(jq -nc \
        --arg url "https://discord.com/api/webhooks/1234567890/e2e-${TEST_ID}" \
        '{url: $url}')
    run runner_e2e_connect_manual_connector discord-webhook api-token "$AGENT_ID" "$values"
    echo "$output"
    assert_success
    CONNECTOR_ACCOUNT_ID=$(jq -er \
        '.id | select(type == "string" and length > 0)' \
        <<<"$output")

    # Raw DNS has dedicated runner coverage. Pin the synthetic placeholder's
    # public sink so this test owns only firewall classification and rewriting.
    local prompt
    prompt=$(cat <<'EOF'
printf 'DISCORD_WEBHOOK_URL=%s\n' "$DISCORD_WEBHOOK_URL"
# Leave room for connection setup around the proxy's 10-second auth deadline.
curl --silent --show-error --max-time 15 \
    --resolve 'firewall-placeholder.vm3.ai:443:8.8.8.8' \
    --output /dev/null \
    "$DISCORD_WEBHOOK_URL" || true
printf 'DISCORD_REQUEST_SENT\n'
EOF
)
    run runner_e2e_start_chat_run "$AGENT_ID" "$prompt"
    echo "$output"
    assert_success
    RUN_ID=$(jq -er '.runId | select(type == "string" and length > 0)' <<<"$output")
    THREAD_ID=$(jq -er '.threadId' <<<"$output")

    run runner_wait_for_run "$RUN_ID" 180
    echo "$output"
    assert_success

    run runner_e2e_wait_for_chat_text "$THREAD_ID" "$RUN_ID" DISCORD_REQUEST_SENT
    echo "$output"
    assert_success
    assert_output --partial \
        "DISCORD_WEBHOOK_URL=https://firewall-placeholder.vm3.ai/discord-webhook/hook"

    run runner_e2e_wait_for_firewall_log \
        "$RUN_ID" \
        discord-webhook \
        firewall-placeholder.vm3.ai \
        '["DISCORD_WEBHOOK_URL"]' \
        true
    echo "$output"
    assert_success
}
