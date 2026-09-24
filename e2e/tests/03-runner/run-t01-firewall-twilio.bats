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
    runner_e2e_teardown_test twilio
}

@test "runner firewall resolves Twilio auth without exposing raw credentials" {
    run create_runner_agent "runner-firewall-twilio-${TEST_ID}"
    echo "$output"
    assert_success
    AGENT_ID="$output"

    local account_sid auth_token values public_surfaces
    printf -v account_sid 'AC%016x%016x' "$RANDOM" "$RANDOM"
    printf -v auth_token '%016x%016x' "$RANDOM" "$RANDOM"
    values=$(jq -nc \
        --arg accountSid "$account_sid" \
        --arg authToken "$auth_token" \
        '{accountSid: $accountSid, authToken: $authToken}')
    run runner_e2e_connect_manual_connector twilio api-token "$AGENT_ID" "$values"
    echo "$output"
    assert_success
    CONNECTOR_ACCOUNT_ID=$(jq -er \
        '.id | select(type == "string" and length > 0)' \
        <<<"$output")
    public_surfaces="$output"$'\n'

    local prompt
    prompt=$(cat <<'EOF'
printf 'TWILIO_ACCOUNT_SID=%s\n' "$TWILIO_ACCOUNT_SID"
printf 'TWILIO_AUTH_TOKEN=%s\n' "$TWILIO_AUTH_TOKEN"
# Keep the request on Twilio's real IPv4 authority instead of an unrelated sink.
# The 15-second budget leaves room around the proxy's 10-second auth deadline.
# Assert the platform's auth/redaction telemetry, not Twilio's application response.
curl --ipv4 --silent --show-error --max-time 15 \
    --output /dev/null \
    'https://api.twilio.com/2010-04-01/Accounts.json' || true
printf 'TWILIO_REQUEST_SENT\n'
EOF
)
    run runner_e2e_start_chat_run "$AGENT_ID" "$prompt"
    echo "$output"
    assert_success
    public_surfaces+="$output"$'\n'
    RUN_ID=$(jq -er '.runId | select(type == "string" and length > 0)' <<<"$output")
    THREAD_ID=$(jq -er '.threadId' <<<"$output")

    run runner_wait_for_run "$RUN_ID" 180
    echo "$output"
    assert_success
    public_surfaces+="$output"$'\n'

    run runner_e2e_wait_for_chat_text "$THREAD_ID" "$RUN_ID" TWILIO_REQUEST_SENT
    echo "$output"
    assert_success
    public_surfaces+="$output"$'\n'
    assert_output --partial "TWILIO_ACCOUNT_SID=ACCoffeeSafeLocalCoffeeSafeLocalCo"
    assert_output --partial "TWILIO_AUTH_TOKEN=c0ffee5afe10ca1c0ffee5afe10ca1c0"

    run runner_api_curl "/api/runs/${RUN_ID}/context"
    echo "$output"
    assert_success
    public_surfaces+="$output"$'\n'

    run runner_chat_event_rows "$THREAD_ID"
    echo "$output"
    assert_success
    public_surfaces+="$output"$'\n'

    run runner_e2e_wait_for_firewall_log \
        "$RUN_ID" \
        twilio \
        api.twilio.com \
        '["TWILIO_ACCOUNT_SID","TWILIO_AUTH_TOKEN"]'
    echo "$output"
    assert_success
    public_surfaces+="$output"$'\n'

    local raw_credential
    for raw_credential in "$account_sid" "$auth_token"; do
        if [[ "$public_surfaces" == *"$raw_credential"* ]]; then
            fail "raw Twilio credential appeared in a public runner surface"
        fi
    done
}
