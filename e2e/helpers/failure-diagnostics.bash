#!/usr/bin/env bash

e2e_report_failure() {
    if [[ -n "${BATS_TEST_TMPDIR:-}" ]]; then
        # ERR can propagate through several helper frames; collect only once.
        if ! mkdir "${BATS_TEST_TMPDIR}/failure-reported" 2>/dev/null; then
            return 0
        fi
    fi
    printf 'E2E failure: file=%s test=%q exit=%s\n' \
        "${BATS_TEST_FILENAME##*/}" "${BATS_TEST_DESCRIPTION:-}" "$1" >&2

    if [[ -z "${BATS_TEST_TMPDIR:-}" ]]; then
        return 0
    fi

    local trace="${BATS_TEST_TMPDIR}/http-responses.jsonl"
    if [[ -f "$trace" ]]; then
        echo 'Recent E2E API responses (at most 20):' >&2
        tail -n 20 "$trace" >&2
    fi

    local runs="${BATS_TEST_TMPDIR}/runner-run-ids"
    if [[ ! -f "$runs" ]]; then
        return 0
    fi

    # Inspect only runs observed by this test, before teardown deletes their threads.
    # At most three runs and one bounded page per run keep failure handling small.
    local run_id response started_at=$SECONDS
    local -a run_ids=()
    mapfile -t run_ids < <(awk '!seen[$0]++' "$runs" | tail -n 3)
    for run_id in "${run_ids[@]}"; do
        if ((SECONDS - started_at >= 8)); then
            echo 'Runner diagnostics stopped at the failure-report budget' >&2
            break
        fi
        if response=$(E2E_CURL_CONNECT_TIMEOUT_SECONDS=1 E2E_CURL_MAX_TIME_SECONDS=2 \
            _runner_api_curl 1 "/api/runs/${run_id}/network?limit=50&order=desc" 2>/dev/null); then
            # Metadata only: captured bodies, auth material, URL queries and arbitrary
            # provider error strings can contain credentials even in failed responses.
            if ! jq -ce --arg runId "$run_id" '
                {
                    run_id: $runId,
                    has_more: .hasMore,
                    rows_returned: (.networkLogs | length),
                    http: [.networkLogs[] | select(.type == "http") | {
                        timestamp, host, method, status, action, response_size,
                        content_type: .response_headers["content-type"],
                        firewall_name, firewall_permission,
                        connector_diagnostic_reason,
                        transport_error_recorded: (.error != null)
                    }][:20],
                    http_rows_omitted: ([.networkLogs[] | select(.type == "http")] | length | . - 20 | if . < 0 then 0 else . end),
                    page_protocol_counts: ([.networkLogs[] | .type] | group_by(.) | map({
                        type: .[0], count: length
                    }))
                }
            ' <<<"$response" >&2 2>/dev/null; then
                printf 'Runner diagnostics unavailable: run_id=%s invalid_network_page\n' "$run_id" >&2
            fi
        else
            printf 'Runner diagnostics unavailable: run_id=%s request_failed\n' "$run_id" >&2
        fi
    done
}
