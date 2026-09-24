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
    runner_e2e_teardown_test
}

@test "runner captures a safe marker request header in network telemetry" {
    run create_runner_agent "runner-network-request-headers-${TEST_ID}"
    echo "$output"
    assert_success
    AGENT_ID="$output"

    # Date is a low-risk value-preserving capture header. Derive a unique valid
    # value from this test so the assertion does not weaken arbitrary-header redaction.
    local marker_checksum marker_epoch marker_value
    marker_checksum=$(printf '%s' "$TEST_ID" | cksum | awk '{print $1}')
    marker_epoch=$((946684800 + marker_checksum))
    marker_value=$(LC_ALL=C date -u --date="@${marker_epoch}" '+%a, %d %b %Y %H:%M:%S GMT')

    local prompt
    prompt=$(cat <<EOF
curl --silent --show-error --max-time 10 \
    --http1.1 \
    --header 'Date: ${marker_value}' \
    --output /dev/null \
    https://www.google.com/robots.txt
printf 'NETWORK_REQUEST_HEADERS_DONE\n'
EOF
)
    run runner_e2e_start_chat_run "$AGENT_ID" "$prompt" true
    echo "$output"
    assert_success
    RUN_ID=$(jq -er '.runId | select(type == "string" and length > 0)' <<<"$output")
    THREAD_ID=$(jq -er '.threadId | select(type == "string" and length > 0)' <<<"$output")

    run runner_wait_for_run "$RUN_ID" 150
    echo "$output"
    assert_success

    run runner_e2e_wait_for_chat_text \
        "$THREAD_ID" \
        "$RUN_ID" \
        NETWORK_REQUEST_HEADERS_DONE \
        30
    echo "$output"
    assert_success

    local network_logs='[]'
    local telemetry_found=false
    local started_at=$SECONDS
    while ((SECONDS - started_at < 60)); do
        if network_logs=$(runner_e2e_network_logs "$RUN_ID" 2>&1) &&
            jq -e --arg markerValue "$marker_value" '
                any(.[];
                    .type == "http" and
                    .host == "www.google.com" and
                    .method == "GET" and
                    any((.request_headers // {}) | to_entries[];
                        (.key | ascii_downcase) == "date" and
                        .value == $markerValue))
            ' <<<"$network_logs" >/dev/null; then
            telemetry_found=true
            break
        fi
        sleep 2
    done

    if [[ "$telemetry_found" != "true" ]]; then
        echo "Missing captured marker request header for run ${RUN_ID}" >&2
        local telemetry_summary
        if telemetry_summary=$(jq -c --arg markerValue "$marker_value" '
            [.[] |
                select(.type == "http" and .host == "www.google.com") |
                {
                    method,
                    status,
                    error,
                    marker_header_present: any(
                        (.request_headers // {}) | to_entries[];
                        (.key | ascii_downcase) == "date"
                    ),
                    marker_header_matches: any(
                        (.request_headers // {}) | to_entries[];
                        (.key | ascii_downcase) == "date" and
                        .value == $markerValue
                    )
                }]
        ' <<<"$network_logs" 2>/dev/null); then
            echo "Relevant network telemetry: ${telemetry_summary}" >&2
        else
            echo "Network telemetry response could not be decoded" >&2
        fi
        return 1
    fi
}
