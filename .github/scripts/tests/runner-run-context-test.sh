#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=e2e/helpers/runner-chat.bash
source "${repo_root}/e2e/helpers/runner-chat.bash"
# shellcheck source=e2e/helpers/runner-api.bash
source "${repo_root}/e2e/helpers/runner-api.bash"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
stdout_file="${tmp_dir}/stdout"
stderr_file="${tmp_dir}/stderr"
attempts_file="${tmp_dir}/attempts"
budgets_file="${tmp_dir}/budgets"
sleeps_file="${tmp_dir}/sleeps"
expected_file="${tmp_dir}/expected"

fail() {
    echo "FAIL: $1" >&2
    exit 1
}

assert_file_equals() {
    printf '%s' "$1" >"$expected_file"
    diff -u "$expected_file" "$2" || fail "unexpected output in $2"
}

assert_attempts() {
    local actual
    actual="$(<"$attempts_file")"
    [[ "$actual" == "$1" ]] || fail "expected $1 request(s), got ${actual}"
}

assert_status() {
    [[ "$request_status" == "$1" ]] || fail "expected exit $1, got ${request_status}"
}

export E2E_API_URL="https://pr-context-api.example.test/"
export E2E_API_TOKEN="synthetic-context-api-token"
export VERCEL_AUTOMATION_BYPASS_SECRET="synthetic-context-bypass-secret"
unset E2E_CURL_MAX_TIME_SECONDS E2E_CURL_CONNECT_TIMEOUT_SECONDS
ready_body='{"runId":"run-1","environment":{"TOKEN":"placeholder"},"firewalls":[]}'
pending_body='{"error":{"message":"Run context not available","code":"NOT_FOUND"}}'
vercel_logs_search='https://vercel.com/okou/vm0-api/logs?search=requestHost%3Apr-context-api.example.test+requestPath%3A%2Fapi%2Fruns%2Frun-1%2Fcontext'
mock_mode=ready
mock_http_status=200
mock_body="$ready_body"
mock_transport_status=35

# Exercise the actual HTTP helper at its external curl command boundary. The
# fixture never contacts a preview, provider, database or internal test endpoint.
curl() {
    local request_url="${!#}"
    local request_method='' write_out='' max_time='' connect_timeout=''
    local fail_with_body=false
    while (($# > 0)); do
        case "$1" in
            --request)
                shift
                request_method="$1"
                ;;
            --write-out)
                shift
                write_out="$1"
                ;;
            --max-time)
                shift
                max_time="$1"
                ;;
            --connect-timeout)
                shift
                connect_timeout="$1"
                ;;
            --fail-with-body)
                fail_with_body=true
                ;;
            --no-fail-with-body)
                fail_with_body=false
                ;;
        esac
        shift
    done
    [[ "$request_url" == "https://pr-context-api.example.test/api/runs/run-1/context" ]] || fail "unexpected URL"
    [[ "$request_method" == GET ]] || fail "context observation must be an explicit GET"
    [[ "$fail_with_body" == false ]] || fail "HTTP status must be captured independently"
    [[ "$write_out" == $'\n%{http_code}' ]] || fail "missing HTTP response framing"
    printf '%s %s\n' "$max_time" "$connect_timeout" >>"$budgets_file"

    local attempt http_status="$mock_http_status" body="$mock_body"
    attempt="$(<"$attempts_file")"
    attempt=$((attempt + 1))
    printf '%s' "$attempt" >"$attempts_file"
    case "$mock_mode" in
        ready)
            http_status=200
            body="$ready_body"
            ;;
        delayed)
            if ((attempt <= 2)); then
                http_status=404
                body="$pending_body"
            else
                http_status=200
                body="$ready_body"
            fi
            ;;
        pending)
            http_status=404
            body="$pending_body"
            ;;
        response)
            ;;
        transport)
            printf '\n000'
            echo "curl: (${mock_transport_status}) transport failed" >&2
            return "$mock_transport_status"
            ;;
        *)
            fail "unknown curl fixture"
            ;;
    esac
    printf '%s\n%s' "$body" "$http_status"
}

# Advance only the shell observation clock; the regression has no real sleeps
# or elapsed-wall-clock assertions. Production still waits on the public GET.
sleep() {
    [[ "$1" == 1 || "$1" == 2 ]] || fail "unexpected polling interval"
    printf '%s\n' "$1" >>"$sleeps_file"
    SECONDS=$((SECONDS + $1))
}

run_context() {
    printf '0' >"$attempts_file"
    : >"$budgets_file"
    : >"$sleeps_file"
    SECONDS=0
    if runner_e2e_wait_for_run_context run-1 "$@" >"$stdout_file" 2>"$stderr_file"; then
        request_status=0
    else
        request_status=$?
    fi
    local sensitive_value
    for sensitive_value in "$E2E_API_TOKEN" "$VERCEL_AUTOMATION_BYPASS_SECRET"; do
        if grep -Fq "$sensitive_value" "$stdout_file" "$stderr_file"; then
            fail "credential leaked in helper output"
        fi
    done
}

mock_mode=ready
run_context
assert_status 0
assert_attempts 1
assert_file_equals "$ready_body"$'\n' "$stdout_file"
assert_file_equals '' "$stderr_file"
assert_file_equals '' "$sleeps_file"
assert_file_equals $'30 10\n' "$budgets_file"

mock_mode=delayed
run_context
assert_status 0
assert_attempts 3
assert_file_equals "$ready_body"$'\n' "$stdout_file"
assert_file_equals '' "$stderr_file"
assert_file_equals $'2\n2\n' "$sleeps_file"
jq -se 'length == 1 and .[0].runId == "run-1"' "$stdout_file" >/dev/null || fail "success was not one matching-run JSON document"

# Both HTTP request budgets and the final polling pause share the total deadline.
mock_mode=pending
run_context 5
assert_status 1
assert_attempts 3
assert_file_equals '' "$stdout_file"
assert_file_equals $'5 5\n3 3\n1 1\n' "$budgets_file"
assert_file_equals $'2\n2\n1\n' "$sleeps_file"
grep -Fq 'Timed out waiting for context snapshot for run run-1 after 5s' "$stderr_file" || fail "missing deadline diagnostic"
grep -Fq "Last context response (HTTP 404): $pending_body" "$stderr_file" || fail "missing last response"
grep -Fq "${vercel_logs_search}+status%3A404&timeline=past12Hours" "$stderr_file" || fail "missing request log link"

mock_mode=ready
E2E_CURL_MAX_TIME_SECONDS=3 E2E_CURL_CONNECT_TIMEOUT_SECONDS=1 run_context
assert_status 0
assert_file_equals $'3 1\n' "$budgets_file"

mock_mode=response
mock_body='{"error":{"message":"Run not found","code":"NOT_FOUND"}}'
for mock_http_status in 400 401 403 404 429 500 503; do
    run_context
    assert_status 22
    assert_attempts 1
    assert_file_equals '' "$stdout_file"
    assert_file_equals '' "$sleeps_file"
    grep -Fq "Last context response (HTTP ${mock_http_status}): $mock_body" "$stderr_file" || fail "HTTP failure lost its body/status"
    grep -Fq "${vercel_logs_search}+status%3A${mock_http_status}&timeline=past12Hours" "$stderr_file" || fail "HTTP failure lost its log link"
done

# A matching message without the exact status/code/shape is not snapshot readiness.
mock_http_status=404
for mock_body in \
    '{"error":{"message":"Run context not available","code":"FORBIDDEN"}}' \
    '{"error":{"message":"Run context not available","code":"NOT_FOUND"},"other":true}' \
    "$pending_body"$'\n'"$pending_body" \
    'not-json'; do
    run_context
    assert_status 22
    assert_attempts 1
    assert_file_equals '' "$sleeps_file"
done
mock_http_status=500
mock_body="$pending_body"
run_context
assert_status 22
assert_attempts 1

mock_http_status=200
for mock_body in \
    'not-json' \
    'null' \
    '{}' \
    '{"runId":"another-run"}' \
    '[{"runId":"run-1"}]' \
    "$ready_body"$'\n'"$ready_body"; do
    run_context
    assert_status 1
    assert_attempts 1
    assert_file_equals '' "$stdout_file"
    assert_file_equals '' "$sleeps_file"
    grep -Fq 'Invalid context snapshot for run run-1' "$stderr_file" || fail "invalid success body was not diagnosed"
done

mock_mode=transport
for mock_transport_status in 28 35; do
    run_context
    assert_status "$mock_transport_status"
    assert_attempts 1
    assert_file_equals '' "$stdout_file"
    assert_file_equals '' "$sleeps_file"
    grep -Fq "curl_status=${mock_transport_status}" "$stderr_file" || fail "transport exit status was lost"
    grep -Fq "${vercel_logs_search}&timeline=past12Hours" "$stderr_file" || fail "transport failure needs a status-free log link"
done

run_context 0
assert_status 1
assert_attempts 0
assert_file_equals '' "$stdout_file"
grep -Fq 'Run context timeout must be a positive integer' "$stderr_file" || fail "invalid deadline was not rejected"

echo "runner context readiness tests passed"
