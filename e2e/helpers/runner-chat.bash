#!/usr/bin/env bash

runner_api_token() {
    if [[ -z "${E2E_API_TOKEN:-}" ]]; then
        echo "E2E_API_TOKEN is required" >&2
        return 1
    fi
    printf '%s' "$E2E_API_TOKEN"
}

runner_api_url() {
    if [[ -z "${E2E_API_URL:-}" ]]; then
        echo "E2E_API_URL is required" >&2
        return 1
    fi
    printf '%s' "${E2E_API_URL%/}"
}

require_runner_api_credentials() {
    runner_api_token >/dev/null && runner_api_url >/dev/null
}

# Returns the Vercel log search for one host and path without a status term,
# so callers decide whether to narrow the search by response status.
_runner_api_vercel_logs_url_prefix() {
    local base="$1"
    local path="$2"
    local request_host request_path request_host_search request_path_search

    request_host="${base#*://}"
    request_host="${request_host%%/*}"
    request_path="${path%%\?*}"
    request_host_search="${request_host//%/%25}"
    request_host_search="${request_host_search//:/%3A}"
    request_path_search="${request_path//%/%25}"
    request_path_search="${request_path_search//\//%2F}"
    request_path_search="${request_path_search//:/%3A}"
    printf 'https://vercel.com/okou/vm0-api/logs?search=requestHost%%3A%s+requestPath%%3A%s' \
        "$request_host_search" "$request_path_search"
}

# A request that carries neither a method override nor a body is a plain GET,
# and only a plain GET may be sent again: the API may already have applied a
# write whose response never arrived.
_runner_api_request_is_repeatable() {
    local arg
    for arg in "$@"; do
        case "$arg" in
            -X* | --request | --request=* | \
                -d* | --data | --data=* | --data-* | \
                -F* | --form | --form=* | \
                -T* | --upload-file | --upload-file=*)
                return 1
                ;;
        esac
    done
    return 0
}

runner_api_curl() {
    local path="$1"
    shift

    local token base request_url diagnostic_url vercel_logs_url_prefix
    local vercel_logs_url_prefix_write_out vercel_log_write_out
    token="$(runner_api_token)" || return 1
    base="$(runner_api_url)" || return 1
    request_url="$base$path"
    diagnostic_url="${request_url%%\?*}"
    vercel_logs_url_prefix="$(_runner_api_vercel_logs_url_prefix \
        "$base" "$path")"
    vercel_logs_url_prefix_write_out="${vercel_logs_url_prefix//%/%%}"
    vercel_log_write_out="%{onerror}%{stderr}Vercel logs: ${vercel_logs_url_prefix_write_out}+status%%3A%{http_code}&timeline=past12Hours\n"

    local -a headers=(
        -H "Authorization: Bearer $token"
        -H "Content-Type: application/json"
    )
    if [[ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]]; then
        headers+=(
            -H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET"
        )
    fi

    # curl exits `28` when the connect/transfer budget expires before the
    # deployment answers anything, while `--fail-with-body` reports a served
    # HTTP error as `22`. Only `28` means the request produced no response, so
    # only `28` is sent again, and only for a repeatable request. Each attempt
    # is buffered so a partial body is replaced rather than concatenated.
    local no_response_status=28
    local max_attempts=1
    if _runner_api_request_is_repeatable "$@"; then
        max_attempts=2
    fi

    # Command substitution strips trailing newlines, so the exit status is
    # appended behind a marker and read back from the last occurrence. That
    # keeps the emitted response byte-for-byte identical to an unbuffered curl.
    local exit_marker=$'\nRUNNER_API_CURL_EXIT:'

    # Bats combines both streams in `$output`. Hold transient diagnostics until
    # the overall request fails so a recovered GET remains machine-readable.
    local diagnostics_file
    diagnostics_file="$(mktemp "${BATS_TEST_TMPDIR:-/tmp}/runner-api-curl-stderr.XXXXXX")" || return

    local body="" curl_status=0 attempt
    for ((attempt = 1; attempt <= max_attempts; attempt += 1)); do
        body="$(
            curl --fail-with-body --silent --show-error \
                --write-out "$vercel_log_write_out" \
                --connect-timeout "${E2E_CURL_CONNECT_TIMEOUT_SECONDS:-10}" \
                --max-time "${E2E_CURL_MAX_TIME_SECONDS:-30}" \
                "${headers[@]}" \
                "$@" \
                "$request_url" \
                2>>"$diagnostics_file"
            printf '%s%d' "$exit_marker" "$?"
        )"
        curl_status="${body##*"$exit_marker"}"
        body="${body%"$exit_marker"*}"

        if ((curl_status != no_response_status)) ||
            ((attempt == max_attempts)); then
            break
        fi
        printf 'runner_api_curl retrying %s after no response (attempt %d of %d)\n' \
            "$diagnostic_url" "$attempt" "$max_attempts" >>"$diagnostics_file"
    done

    printf '%s' "$body"

    if ((curl_status != 0)); then
        cat "$diagnostics_file" >&2
        printf 'runner_api_curl failed: url=%s curl_status=%d\n' \
            "$diagnostic_url" "$curl_status" >&2
        if ((curl_status == no_response_status)); then
            # A stalled request carries no status, so the status-filtered
            # search above finds nothing even when the API completed the
            # request late.
            printf 'runner_api_curl received no response from %s within %ss across %d attempt(s); the API may have answered after the client gave up: %s&timeline=past12Hours\n' \
                "$diagnostic_url" "${E2E_CURL_MAX_TIME_SECONDS:-30}" \
                "$attempt" "$vercel_logs_url_prefix" >&2
        fi
    fi
    rm -f "$diagnostics_file"
    return "$curl_status"
}

runner_chat_event_rows() {
    local thread_id="$1"
    local accumulated='[]'
    local since_seq_id=0
    local since_event_id=''
    local response rows row_count next_seq_id next_event_id request_path
    local page_number

    for ((page_number = 1; page_number <= 100; page_number += 1)); do
        request_path="/api/chat-threads/${thread_id}/event-rows?sinceSeqId=${since_seq_id}&limit=50"
        if ((since_seq_id > 0)); then
            request_path+="&sinceEventId=${since_event_id}"
        fi
        response="$(runner_api_curl \
            "$request_path" \
            -H "X-Chat-Event-Schema-Version: 7")" || return
        rows="$(jq -ce \
            '.rows | if type == "array" then . else error("invalid rows") end' \
            <<<"$response")" || {
            echo "Chat event rows returned an invalid page: $response" >&2
            return 1
        }
        accumulated="$(jq -cn \
            --argjson accumulated "$accumulated" \
            --argjson rows "$rows" \
            '$accumulated + $rows')" || return
        row_count="$(jq -r 'length' <<<"$rows")" || return
        if ((row_count < 50)); then
            jq -cn --argjson rows "$accumulated" '{rows: $rows}'
            return
        fi
        next_seq_id="$(jq -er \
            '.[-1].seqId | select(type == "number" and . >= 0)' \
            <<<"$rows")" || {
            echo "Chat event rows page is missing its final sequence ID: $response" >&2
            return 1
        }
        next_event_id="$(jq -er \
            '.[-1].id | select(type == "string" and length > 0)' \
            <<<"$rows")" || {
            echo "Chat event rows page is missing its final event ID: $response" >&2
            return 1
        }
        if ((next_seq_id <= since_seq_id)); then
            echo "Chat event rows cursor did not advance: $response" >&2
            return 1
        fi
        since_seq_id="$next_seq_id"
        since_event_id="$next_event_id"
    done

    echo "Chat event rows exceeded 100 pages for thread ${thread_id}" >&2
    return 1
}

create_runner_agent() {
    local display_name="$1"
    local payload response

    payload="$(jq -nc \
        --arg displayName "$display_name" \
        '{displayName: $displayName, visibility: "private"}')"
    response="$(runner_api_curl "/api/agents" -X POST -d "$payload")" || return 1
    jq -er '.agentId | select(type == "string" and length > 0)' <<< "$response"
}

set_runner_agent_instructions() {
    local agent_id="$1"
    local content="$2"
    local payload

    payload="$(jq -nc --arg content "$content" '{content: $content}')"
    runner_api_curl "/api/agents/$agent_id/instructions" \
        -X PUT \
        -d "$payload" \
        >/dev/null
}

delete_runner_agent() {
    local agent_id="$1"
    runner_api_curl "/api/agents/$agent_id" -X DELETE >/dev/null
}

# Temporary Stage 0 E2E teardown containment. Remove this helper and restore
# delete_runner_agent when #26938's final version-contract/drop stage removes
# the production legacy-version deletion veto.
delete_runner_agent_for_stage0_teardown() {
    local agent_id="$1"
    local request_path response http_status response_body attempt
    local base vercel_logs_url_prefix

    request_path="/api/agents/$agent_id"

    for ((attempt = 1; attempt <= 5; attempt += 1)); do
        response="$(runner_api_curl \
            "$request_path" \
            -X DELETE \
            --no-fail-with-body \
            --write-out $'\n%{http_code}')" || return
        http_status="${response##*$'\n'}"
        response_body="${response%$'\n'*}"

        if [[ "$http_status" == "204" && -z "$response_body" ]]; then
            return 0
        fi

        if [[ "$http_status" == "404" ]] && jq -e --arg agent_id "$agent_id" '
            . == {
                error: {
                    message: ("Agent not found: " + $agent_id),
                    code: "NOT_FOUND"
                }
            }
        ' <<<"$response_body" >/dev/null 2>&1; then
            return 0
        fi

        if [[ "$http_status" == "409" ]] && jq -e '
            . == {
                error: {
                    message: "Cannot delete agent while its configuration is being migrated",
                    code: "CONFLICT"
                }
            }
        ' <<<"$response_body" >/dev/null 2>&1; then
            return 0
        fi

        if [[ "$http_status" == "409" ]] && jq -e '
            . == {
                error: {
                    message: "Cannot delete agent right now; retry shortly",
                    code: "CONFLICT"
                }
            }
        ' <<<"$response_body" >/dev/null 2>&1 && ((attempt < 5)); then
            sleep 0.25
            continue
        fi

        printf 'Stage 0 Runner E2E agent teardown failed with HTTP %s: %s\n' \
            "$http_status" "$response_body" >&2
        base="$(runner_api_url)" || return 1
        vercel_logs_url_prefix="$(_runner_api_vercel_logs_url_prefix \
            "$base" "$request_path")"
        printf 'Vercel logs: %s+status%%3A%s&timeline=past12Hours\n' \
            "$vercel_logs_url_prefix" "$http_status" >&2
        return 1
    done
}

_runner_uuid() {
    tr -d '\n' < /proc/sys/kernel/random/uuid
}

runner_chat_send() {
    local agent_id="$1"
    local prompt="$2"
    local thread_id="$3"
    local selected_model="$4"
    local client_event_id="${5:-}"
    local capture_network_bodies="${6:-false}"
    local parts

    parts="$(jq -nc --arg prompt "$prompt" '[{type: "text", text: $prompt}]')"
    runner_chat_send_parts \
        "$agent_id" \
        "$prompt" \
        "$parts" \
        "$thread_id" \
        "$selected_model" \
        "$client_event_id" \
        "$capture_network_bodies"
}

runner_chat_send_parts() {
    local agent_id="$1"
    local prompt="$2"
    local parts="$3"
    local thread_id="$4"
    local selected_model="$5"
    local client_event_id="${6:-}"
    local capture_network_bodies="${7:-false}"
    local payload

    if [[ -z "$client_event_id" ]]; then
        client_event_id="$(_runner_uuid)"
    fi
    if [[ -n "$thread_id" ]]; then
        payload="$(jq -nc \
            --arg agentId "$agent_id" \
            --arg prompt "$prompt" \
            --arg threadId "$thread_id" \
            --arg clientEventId "$client_event_id" \
            --argjson parts "$parts" \
            --argjson captureNetworkBodies "$capture_network_bodies" \
            '{
                agentId: $agentId,
                prompt: $prompt,
                threadId: $threadId,
                clientEventId: $clientEventId,
                userMessage: {version: 1, parts: $parts},
                hasTextContent: true
            } + if $captureNetworkBodies then {captureNetworkBodies: true} else {} end')"
    else
        payload="$(jq -nc \
            --arg agentId "$agent_id" \
            --arg prompt "$prompt" \
            --arg model "$selected_model" \
            --arg clientEventId "$client_event_id" \
            --argjson parts "$parts" \
            --argjson captureNetworkBodies "$capture_network_bodies" \
            '{
                agentId: $agentId,
                prompt: $prompt,
                model: $model,
                clientEventId: $clientEventId,
                userMessage: {version: 1, parts: $parts},
                hasTextContent: true
            } + if $captureNetworkBodies then {captureNetworkBodies: true} else {} end')"
    fi

    runner_api_curl "/api/chat/events" -X POST -d "$payload"
}

runner_wait_for_run() {
    local run_id="$1"
    local timeout="${2:-100}"
    local interval="${RUNNER_RUN_POLL_INTERVAL_SECONDS:-2}"
    local start=$SECONDS
    local response="" run_status=""

    while (( SECONDS - start < timeout )); do
        if response="$(runner_api_curl "/api/runs/$run_id" 2>&1)"; then
            run_status="$(jq -r '.status // empty' <<< "$response")"
            case "$run_status" in
                completed)
                    printf '%s\n' "$response"
                    return 0
                    ;;
                failed|timeout|cancelled)
                    echo "# Run $run_id reached terminal status: $run_status" >&2
                    echo "# Run response: $response" >&2
                    return 1
                    ;;
            esac
        fi
        sleep "$interval"
    done

    echo "# Timed out (${timeout}s) waiting for run $run_id" >&2
    echo "# Last run response: $response" >&2
    return 1
}

runner_wait_for_run_running() {
    local run_id="$1"
    local timeout="${2:-60}"
    local interval="${RUNNER_RUN_POLL_INTERVAL_SECONDS:-2}"
    local start=$SECONDS
    local response="" run_status=""

    while (( SECONDS - start < timeout )); do
        if response="$(runner_api_curl "/api/runs/$run_id" 2>&1)"; then
            run_status="$(jq -r '.status // empty' <<< "$response")"
            case "$run_status" in
                running)
                    printf '%s\n' "$response"
                    return 0
                    ;;
                completed|failed|timeout|cancelled)
                    echo "# Run $run_id reached terminal status before steer: $run_status" >&2
                    echo "# Run response: $response" >&2
                    return 1
                    ;;
            esac
        fi
        sleep "$interval"
    done

    echo "# Timed out (${timeout}s) waiting for run $run_id to start" >&2
    echo "# Last run response: $response" >&2
    return 1
}

_wait_for_runner_chat_output() {
    local thread_id="$1"
    local run_id="$2"
    local prompt="$3"
    local timeout="${4:-30}"
    local interval="${RUNNER_CHAT_EVENT_POLL_INTERVAL_SECONDS:-2}"
    local start=$SECONDS
    local response=""

    while (( SECONDS - start < timeout )); do
        if response="$(runner_chat_event_rows "$thread_id" 2>&1)"; then
            if jq -e --arg runId "$run_id" --arg prompt "$prompt" '
                any(.rows[]?;
                    .eventType == "output.message" and
                    .runId == $runId and
                    (.payload.content | contains($prompt))
                ) and
                any(.rows[]?;
                    .eventType == "run.completed" and .runId == $runId
                )
            ' <<< "$response" >/dev/null; then
                return 0
            fi
        fi
        sleep "$interval"
    done

    echo "# Timed out (${timeout}s) waiting for chat output for run $run_id" >&2
    echo "# Last chat event response: $response" >&2
    return 1
}

_wait_for_runner_chat_completion() {
    local thread_id="$1"
    local run_id="$2"
    local timeout="${3:-30}"
    local interval="${RUNNER_CHAT_EVENT_POLL_INTERVAL_SECONDS:-2}"
    local start=$SECONDS
    local response=""
    local output_message=""

    while (( SECONDS - start < timeout )); do
        if response="$(runner_chat_event_rows "$thread_id" 2>&1)" &&
            output_message="$(jq -er --arg runId "$run_id" '
                [
                    .rows[]?
                    | select(
                        .eventType == "output.message" and
                        .runId == $runId
                    )
                    | .payload.content
                    | select(type == "string" and test("\\S"))
                ]
                | last // empty
            ' <<< "$response")" &&
            jq -e --arg runId "$run_id" '
                any(.rows[]?;
                    .eventType == "run.completed" and .runId == $runId
                )
            ' <<< "$response" >/dev/null; then
            printf '%s\n' "$output_message"
            return 0
        fi
        sleep "$interval"
    done

    echo "# Timed out (${timeout}s) waiting for completed chat output for run $run_id" >&2
    echo "# Last chat event response: $response" >&2
    return 1
}

_wait_for_runner_chat_steer_consumed() {
    local thread_id="$1"
    local run_id="$2"
    local steer_event_id="$3"
    local steer_prompt="$4"
    local expected_output="$5"
    local timeout="${6:-45}"
    local interval="${RUNNER_CHAT_EVENT_POLL_INTERVAL_SECONDS:-2}"
    local start=$SECONDS
    local response=""

    while (( SECONDS - start < timeout )); do
        if response="$(runner_chat_event_rows "$thread_id" 2>&1)"; then
            if jq -e \
                --arg runId "$run_id" \
                --arg steerEventId "$steer_event_id" \
                --arg steerPrompt "$steer_prompt" \
                --arg expectedOutput "$expected_output" '
                any(.rows[]?;
                    .eventType == "input.prompt" and
                    .runId == $runId and
                    .revokesEventId == $steerEventId and
                    any(.payload.userMessage.parts[]?;
                        .type == "text" and .text == $steerPrompt
                    )
                ) and
                any(.rows[]?;
                    .eventType == "output.message" and
                    .runId == $runId and
                    (.payload.content | contains($expectedOutput))
                ) and
                any(.rows[]?;
                    .eventType == "run.completed" and .runId == $runId
                ) and
                all(.rows[]?;
                    (.runId == null or .runId == $runId)
                )
            ' <<< "$response" >/dev/null; then
                return 0
            fi
        fi
        sleep "$interval"
    done

    echo "# Timed out (${timeout}s) waiting for steer $steer_event_id to be consumed by run $run_id" >&2
    echo "# Last chat event response: $response" >&2
    return 1
}

runner_chat_steer() {
    local agent_id="$1"
    local initial_prompt="$2"
    local steer_prompt="$3"
    local selected_model="$4"
    local expected_output="$5"
    local run_timeout="${6:-180}"
    local send_response run_id thread_id steer_event_id steer_response run_response

    send_response="$(runner_chat_send \
        "$agent_id" \
        "$initial_prompt" \
        "" \
        "$selected_model")" || return 1
    run_id="$(jq -er '.runId | select(type == "string" and length > 0)' \
        <<< "$send_response")" || return 1
    thread_id="$(jq -er '.threadId | select(type == "string" and length > 0)' \
        <<< "$send_response")" || return 1

    runner_wait_for_run_running "$run_id" 60 >/dev/null || return 1

    steer_event_id="$(_runner_uuid)"
    steer_response="$(runner_chat_send \
        "$agent_id" \
        "$steer_prompt" \
        "$thread_id" \
        "" \
        "$steer_event_id")" || return 1
    if ! jq -e --arg threadId "$thread_id" '
        has("runId") and .runId == null and .threadId == $threadId
    ' <<< "$steer_response" >/dev/null; then
        echo "# Steer created a separate run or thread: $steer_response" >&2
        return 1
    fi

    run_response="$(runner_wait_for_run "$run_id" "$run_timeout")" || return 1
    if ! jq -e '
        .status == "completed" and
        (.result.agentSessionId | type == "string" and length > 0)
    ' <<< "$run_response" >/dev/null; then
        echo "# Completed steered run did not contain a session id: $run_response" >&2
        return 1
    fi

    _wait_for_runner_chat_steer_consumed \
        "$thread_id" \
        "$run_id" \
        "$steer_event_id" \
        "$steer_prompt" \
        "$expected_output" \
        45 || return 1

    jq -cn \
        --arg runId "$run_id" \
        --arg threadId "$thread_id" \
        --arg steerEventId "$steer_event_id" \
        --arg sessionId "$(jq -er '.result.agentSessionId' <<< "$run_response")" \
        '{
            runId: $runId,
            threadId: $threadId,
            steerEventId: $steerEventId,
            sessionId: $sessionId,
            status: "completed"
        }'
}

runner_chat_send_after_completion() {
    local agent_id="$1"
    local thread_id="$2"
    local completed_run_id="$3"
    local prompt="$4"
    local expected_output="$5"
    local run_timeout="${6:-180}"
    local send_response run_id run_response

    send_response="$(runner_chat_send \
        "$agent_id" \
        "$prompt" \
        "$thread_id" \
        "")" || return 1
    if ! jq -e \
        --arg threadId "$thread_id" \
        --arg completedRunId "$completed_run_id" '
        .threadId == $threadId and
        (.runId | type == "string" and length > 0) and
        .runId != $completedRunId
    ' <<< "$send_response" >/dev/null; then
        echo "# Post-completion message did not create a successor run: $send_response" >&2
        return 1
    fi
    run_id="$(jq -er '.runId' <<< "$send_response")" || return 1

    run_response="$(runner_wait_for_run "$run_id" "$run_timeout")" || return 1
    if ! jq -e '
        .status == "completed" and
        (.result.agentSessionId | type == "string" and length > 0)
    ' <<< "$run_response" >/dev/null; then
        echo "# Completed successor run did not contain a session id: $run_response" >&2
        return 1
    fi

    _wait_for_runner_chat_output \
        "$thread_id" \
        "$run_id" \
        "$expected_output" \
        45 || return 1

    jq -cn \
        --arg runId "$run_id" \
        --arg threadId "$thread_id" \
        --arg sessionId "$(jq -er '.result.agentSessionId' <<< "$run_response")" \
        '{
            runId: $runId,
            threadId: $threadId,
            sessionId: $sessionId,
            status: "completed"
        }'
}

_runner_chat_execute() {
    local agent_id="$1"
    local prompt="$2"
    local thread_id="$3"
    local selected_model="$4"
    local send_response run_id resolved_thread_id run_response chat_output

    send_response="$(runner_chat_send \
        "$agent_id" \
        "$prompt" \
        "$thread_id" \
        "$selected_model")" || return 1
    run_id="$(jq -er '.runId | select(type == "string" and length > 0)' <<< "$send_response")" || return 1
    resolved_thread_id="$(jq -er '.threadId | select(type == "string" and length > 0)' <<< "$send_response")" || return 1

    run_response="$(runner_wait_for_run "$run_id")" || return 1
    if ! jq -e '
        .status == "completed" and
        (.result.agentSessionId | type == "string" and length > 0)
    ' <<< "$run_response" >/dev/null; then
        echo "# Completed run did not contain a session id: $run_response" >&2
        return 1
    fi

    chat_output="$(_wait_for_runner_chat_completion \
        "$resolved_thread_id" \
        "$run_id")" || return 1
    if [[ "$chat_output" != *"$prompt"* ]]; then
        echo "# Completed chat output did not contain ${prompt@Q}: $chat_output" >&2
        return 1
    fi

    jq -cn \
        --arg runId "$run_id" \
        --arg threadId "$resolved_thread_id" \
        --arg sessionId "$(jq -er '.result.agentSessionId' <<< "$run_response")" \
        '{
            runId: $runId,
            threadId: $threadId,
            sessionId: $sessionId,
            status: "completed"
        }'
    printf '%s\n' "$chat_output"
}

runner_chat_start() {
    local agent_id="$1"
    local prompt="$2"
    _runner_chat_execute "$agent_id" "$prompt" "" "deepseek-v4-flash"
}

runner_chat_continue() {
    local agent_id="$1"
    local thread_id="$2"
    local prompt="$3"
    _runner_chat_execute "$agent_id" "$prompt" "$thread_id" ""
}

runner_chat_field() {
    local captured_output="$1"
    local filter="$2"
    sed -n '1p' <<< "$captured_output" | jq -er "$filter"
}
