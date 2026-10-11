#!/usr/bin/env bash

runner_e2e_require_environment() {
    require_runner_api_credentials || return
    command -v curl >/dev/null || return
    command -v jq >/dev/null
}

# Behavioral probes need deterministic shell output from the mock Codex
# runtime, not a real model completion. The existing mock-Claude organization
# also exposes this native Codex route; its Claude route and the separate
# real-model accounts remain untouched.
runner_e2e_use_mock_codex_profile() {
    local credentials="/tmp/e2e-api-credentials-runner-mock-claude.json"
    local token api_url
    # An unsuccessful selection must not leave a stale mock marker behind.
    unset E2E_RUNNER_PROFILE E2E_MOCK_CODEX_MODEL
    token="$(jq -er '.token | select(type == "string" and length > 0)' "$credentials")" || return 1
    api_url="$(jq -er '.apiUrl | select(type == "string" and length > 0)' "$credentials")" || return 1
    export E2E_API_TOKEN="$token" E2E_API_URL="$api_url"
    export E2E_RUNNER_PROFILE="mock-codex" E2E_MOCK_CODEX_MODEL="gpt-6-astra"
}

runner_e2e_setup_test() {
    TEST_ID="${E2E_RUNNER_SHARD_INDEX:-local}-$(date +%s)-$RANDOM"
    AGENT_ID=""
    THREAD_ID=""
    RUN_ID=""
    CONNECTOR_ACCOUNT_ID=""
}

runner_e2e_teardown_test() {
    local connector_slug="${1:-}"
    if [[ -n "${RUN_ID:-}" ]]; then
        runner_e2e_cancel_run "$RUN_ID" >/dev/null 2>&1 || true
    fi
    if [[ -n "${THREAD_ID:-}" ]]; then
        runner_e2e_delete_chat_thread "$THREAD_ID" >/dev/null 2>&1 || true
    fi
    if [[ -n "${AGENT_ID:-}" ]]; then
        delete_runner_agent "$AGENT_ID" >/dev/null 2>&1 || true
    fi
    if [[ -n "$connector_slug" && -n "${CONNECTOR_ACCOUNT_ID:-}" ]]; then
        runner_e2e_delete_connector_account \
            "$connector_slug" \
            "$CONNECTOR_ACCOUNT_ID" \
            >/dev/null 2>&1 || true
    fi
}

runner_e2e_connect_manual_connector() {
    local connector_slug="$1"
    local auth_method="$2"
    local agent_id="$3"
    local values="$4"
    local existing_connection_id="${5:-}"
    local account payload response returned_connection_id
    if [[ -n "$existing_connection_id" ]]; then
        account=$(jq -nc \
            --arg connectionId "$existing_connection_id" \
            '{intent: "reconnect", connectionId: $connectionId}')
    else
        account='{"intent":"add"}'
    fi
    payload=$(jq -nc \
        --arg authMethod "$auth_method" \
        --arg agentId "$agent_id" \
        --argjson account "$account" \
        --argjson values "$values" \
        '{authMethod: $authMethod, agentId: $agentId, authorizeAgent: true, account: $account, values: $values}')
    local grant_status=0
    response=$(runner_api_curl "/api/connectors/${connector_slug}/manual-grant" \
        -X POST \
        -d "$payload") || grant_status=$?
    if ((grant_status != 0)); then
        # The response was buffered above. Report only fixed API error codes
        # and public form descriptors, never submitted values or raw bodies.
        local diagnostic
        diagnostic=$(jq -er '
            .error as $error |
            ["BAD_REQUEST", "UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "CONFLICT",
             "PROVIDER_UNAVAILABLE", "INTERNAL_SERVER_ERROR"] as $codes |
            (if ($codes | index($error.code)) != null then $error.code else "REQUEST_FAILED" end) as $code |
            ($error.message // "") as $message |
            if ($message | type) == "string" and
               ($message | test("^(Unknown manual grant field\\(s\\)\\. Expected: |Missing required manual grant field\\(s\\): )[A-Za-z][A-Za-z0-9_, -]{0,511}$"))
            then $code + ": " + $message
            else $code
            end
        ' <<<"$response" 2>/dev/null) || diagnostic="REQUEST_FAILED"
        printf 'Manual connector grant failed: %s\n' "$diagnostic" >&2
        return "$grant_status"
    fi
    returned_connection_id=$(jq -er \
        '.id | select(type == "string" and length > 0)' \
        <<<"$response") || return

    if [[ -n "$existing_connection_id" ]]; then
        [[ "$returned_connection_id" == "$existing_connection_id" ]] || return
    else
        local default_payload default_response
        default_payload=$(jq -nc \
            --arg connectorSlug "$connector_slug" \
            '{target: {kind: "builtin", connectorSlug: $connectorSlug}}')
        default_response=$(runner_api_curl \
            "/api/connector-accounts/${returned_connection_id}/default" \
            -X POST \
            -d "$default_payload") || return
        jq -e \
            --arg connectionId "$returned_connection_id" \
            '.id == $connectionId and .isDefault == true' \
            <<<"$default_response" \
            >/dev/null || return
    fi

    printf '%s\n' "$response"
}

runner_e2e_delete_connector_account() {
    local connector_slug="$1"
    local connection_id="$2"
    local payload
    payload=$(jq -nc \
        --arg connectorSlug "$connector_slug" \
        '{target: {kind: "builtin", connectorSlug: $connectorSlug}}')
    runner_api_curl "/api/connector-accounts/${connection_id}" \
        -X DELETE \
        -d "$payload"
}

runner_e2e_upload_text() {
    local filename="$1"
    local content="$2"
    local content_type="text/plain"
    local size payload prepared upload_id upload_url completed header
    local upload_body upload_status=0
    local -a upload_headers=()
    local -a upload_header_args=()

    size=$(printf '%s' "$content" | wc -c | tr -d '[:space:]')
    payload=$(jq -nc \
        --arg filename "$filename" \
        --arg contentType "$content_type" \
        --argjson size "$size" \
        '{filename: $filename, contentType: $contentType, size: $size}')
    prepared=$(runner_api_curl "/api/uploads/prepare" \
        -X POST \
        -d "$payload") || return
    upload_url=$(jq -er '.uploadUrl | select(type == "string" and length > 0)' \
        <<<"$prepared") || return
    upload_id=$(jq -er '.id | select(type == "string" and length > 0)' \
        <<<"$prepared") || return
    mapfile -t upload_headers < <(jq -r \
        '.uploadHeaders | to_entries[] | "\(.key): \(.value)"' \
        <<<"$prepared")
    for header in "${upload_headers[@]}"; do
        upload_header_args+=(-H "$header")
    done

    upload_body=$(mktemp "${BATS_TEST_TMPDIR:-/tmp}/runner-e2e-upload.XXXXXX") || return
    printf '%s' "$content" >"$upload_body" || {
        rm -f "$upload_body"
        return 1
    }
    curl -fsS \
        --connect-timeout "${E2E_CURL_CONNECT_TIMEOUT_SECONDS:-10}" \
        --max-time "${E2E_CURL_MAX_TIME_SECONDS:-30}" \
        -X PUT \
        "${upload_header_args[@]}" \
        --data-binary "@${upload_body}" \
        "$upload_url" \
        >/dev/null || upload_status=$?
    rm -f "$upload_body"
    ((upload_status == 0)) || return "$upload_status"

    payload=$(jq -nc \
        --arg id "$upload_id" \
        --arg contentType "$content_type" \
        '{id: $id, contentType: $contentType}')
    completed=$(runner_api_curl "/api/uploads/complete" \
        -X POST \
        -d "$payload") || return
    jq -ce '{id, filename, contentType, size}' <<<"$completed"
}

runner_e2e_cancel_run() {
    local run_id="$1"
    runner_api_curl "/api/runs/${run_id}/cancel" -X POST
}

runner_e2e_wait_for_run_status() {
    local run_id="$1"
    local expected_status="$2"
    local timeout_seconds="${3:-90}"
    local started_at=$SECONDS
    local response='{}'
    local run_status=""

    while ((SECONDS - started_at < timeout_seconds)); do
        if response=$(runner_api_curl "/api/runs/${run_id}" 2>&1); then
            run_status=$(jq -r '.status // empty' <<<"$response")
            if [[ "$run_status" == "$expected_status" ]]; then
                printf '%s\n' "$response"
                return 0
            fi
            case "$run_status" in
                completed|failed|timeout|cancelled)
                    echo "Run ${run_id} reached terminal status ${run_status@Q}; expected ${expected_status@Q}" >&2
                    echo "Last run response: ${response}" >&2
                    return 1
                    ;;
            esac
        fi
        sleep 2
    done

    echo "Timed out waiting for run ${run_id} to reach ${expected_status@Q}" >&2
    echo "Last run response: ${response}" >&2
    return 1
}

# Completion does not guarantee query visibility of the asynchronously ingested
# context snapshot. Only the API's specific pending-snapshot response is retryable.
runner_e2e_wait_for_run_context() {
    local run_id="$1"
    local timeout_seconds="${2:-30}"
    if [[ ! "$timeout_seconds" =~ ^[1-9][0-9]*$ ]]; then
        echo "Run context timeout must be a positive integer" >&2
        return 1
    fi

    local started_at=$SECONDS
    local request_path="/api/runs/${run_id}/context"
    local base vercel_logs_url_prefix
    base=$(runner_api_url) || return 1
    vercel_logs_url_prefix=$(_runner_api_vercel_logs_url_prefix \
        "$base" "$request_path")
    local response='' response_body='' http_status='none'
    local remaining_seconds request_timeout connect_timeout curl_status
    local failure='' failure_status=1

    while ((SECONDS - started_at < timeout_seconds)); do
        remaining_seconds=$((timeout_seconds - (SECONDS - started_at)))
        request_timeout=$(jq -ner \
            --argjson remaining "$remaining_seconds" \
            --argjson maximum "${E2E_CURL_MAX_TIME_SECONDS:-30}" \
            '[$remaining, $maximum] | min | select(. > 0)') || return 1
        connect_timeout=$(jq -ner \
            --argjson remaining "$remaining_seconds" \
            --argjson maximum "${E2E_CURL_CONNECT_TIMEOUT_SECONDS:-10}" \
            '[$remaining, $maximum] | min | select(. > 0)') || return 1

        # Explicit GET keeps the transport helper from retrying a no-response
        # failure outside this deadline. HTTP status and JSON stay separate.
        if response=$(runner_api_curl "$request_path" \
            --request GET \
            --no-fail-with-body \
            --write-out $'\n%{http_code}' \
            --connect-timeout "$connect_timeout" \
            --max-time "$request_timeout" 2>&1); then
            http_status="${response##*$'\n'}"
            response_body="${response%$'\n'*}"
        else
            curl_status=$?
            printf '%s\nVercel logs: %s&timeline=past12Hours\n' \
                "$response" "$vercel_logs_url_prefix" >&2
            return "$curl_status"
        fi

        if [[ "$http_status" == "200" ]]; then
            if jq -se --arg runId "$run_id" '
                length == 1 and
                (.[0] | type == "object" and .runId == $runId)
            ' <<<"$response_body" >/dev/null 2>&1; then
                printf '%s\n' "$response_body"
                return 0
            fi
            failure="Invalid context snapshot for run ${run_id}"
            break
        fi

        if [[ "$http_status" != "404" ]] || ! jq -se '
            . == [{error: {
                message: "Run context not available",
                code: "NOT_FOUND"
            }}]
        ' <<<"$response_body" >/dev/null 2>&1; then
            failure="Unexpected context response for run ${run_id}"
            failure_status=22
            break
        fi

        remaining_seconds=$((timeout_seconds - (SECONDS - started_at)))
        if ((remaining_seconds <= 0)); then
            break
        fi
        sleep "$((remaining_seconds < 2 ? remaining_seconds : 2))"
    done

    if [[ -z "$failure" ]]; then
        failure="Timed out waiting for context snapshot for run ${run_id} after ${timeout_seconds}s"
    fi
    printf '%s\nLast context response (HTTP %s): %s\n' \
        "$failure" "$http_status" "$response_body" >&2
    printf 'Vercel logs: %s+status%%3A%s&timeline=past12Hours\n' \
        "$vercel_logs_url_prefix" "$http_status" >&2
    return "$failure_status"
}

runner_e2e_shell_prompt() {
    local script="$1"
    printf '@shell@\nexport npm_config_audit=false\n%s\n@end-shell@' "$script"
}

runner_e2e_start_mock_shell_chat_run() {
    local agent_id="$1"
    local prompt="$2"
    local capture_network_bodies="${3:-false}"
    local shell_prompt
    runner_e2e_require_mock_codex_profile || return 1
    shell_prompt=$(runner_e2e_shell_prompt "$prompt")
    runner_chat_send \
        "$agent_id" \
        "$shell_prompt" \
        "" \
        "$E2E_MOCK_CODEX_MODEL" \
        "" \
        "$capture_network_bodies"
}

runner_e2e_continue_chat_run() {
    local agent_id="$1"
    local thread_id="$2"
    local prompt="$3"
    local shell_prompt
    shell_prompt=$(runner_e2e_shell_prompt "$prompt")
    runner_chat_send "$agent_id" "$shell_prompt" "$thread_id" ""
}

runner_e2e_start_mock_checkpointed_chat_run() {
    local agent_id="$1"
    local checkpoint_script="$2"
    local continuation_script="$3"
    local shell_prompt
    runner_e2e_require_mock_codex_profile || return 1
    shell_prompt=$(printf '@shell-checkpoint@\n%s\n@continue@\n%s' \
        "$checkpoint_script" \
        "$continuation_script")
    runner_chat_send "$agent_id" "$shell_prompt" "" "$E2E_MOCK_CODEX_MODEL"
}

runner_e2e_delete_chat_thread() {
    local thread_id="$1"
    runner_api_curl "/api/chat-threads/${thread_id}" -X DELETE
}

runner_e2e_delete_workflow() {
    local workflow_id="$1"
    runner_api_curl "/api/workflows/${workflow_id}" -X DELETE
}

runner_e2e_wait_for_chat_event() {
    local thread_id="$1"
    local run_id="$2"
    local event_type="$3"
    local timeout_seconds="${4:-90}"
    local started_at=$SECONDS
    local last_events='{}'

    while ((SECONDS - started_at < timeout_seconds)); do
        if last_events=$(runner_chat_event_rows "$thread_id" 2>&1) &&
            jq -e \
                --arg runId "$run_id" \
                --arg eventType "$event_type" \
                'any(.rows[]?; .runId == $runId and .eventType == $eventType)' \
                <<<"$last_events" >/dev/null; then
            printf '%s\n' "$last_events"
            return 0
        fi
        sleep 2
    done

    echo "Timed out waiting for ${event_type@Q} for run ${run_id}" >&2
    echo "Last chat events: ${last_events}" >&2
    return 1
}

runner_e2e_wait_for_usage_event() {
    local thread_id="$1"
    local run_id="$2"
    local provider="$3"
    local timeout_seconds="${4:-90}"
    local started_at=$SECONDS
    local last_events='{}'

    while ((SECONDS - started_at < timeout_seconds)); do
        if last_events=$(runner_chat_event_rows "$thread_id" 2>&1) &&
            jq -e \
                --arg runId "$run_id" \
                --arg provider "$provider" '
                    any(.rows[]?;
                        .runId == $runId and
                        .eventType == "usage.recorded" and
                        (.payload.usage.totalCredits > 0) and
                        any(.payload.usage.breakdown[]?;
                            .kind == "model" and
                            any(.providers[]?;
                                .provider == $provider and .credits > 0
                            )
                        )
                    )
                ' <<<"$last_events" >/dev/null; then
            printf '%s\n' "$last_events"
            return 0
        fi
        sleep 2
    done

    echo "Timed out waiting for usage from ${provider@Q} for run ${run_id}" >&2
    echo "Last chat events: ${last_events}" >&2
    return 1
}

runner_e2e_usage_record() {
    runner_api_curl "/api/usage/record?page=1&pageSize=100&scope=mine&range=24h&tz=UTC&source=chat"
}

runner_e2e_wait_for_usage_record() {
    local thread_id="$1"
    local provider="$2"
    local timeout_seconds="${3:-90}"
    local started_at=$SECONDS
    local last_record='{}'

    while ((SECONDS - started_at < timeout_seconds)); do
        if last_record=$(runner_e2e_usage_record 2>&1) &&
            jq -e \
                --arg threadId "$thread_id" \
                --arg provider "$provider" '
                    any(.rows[]?;
                        .threadId == $threadId and
                        .credits > 0 and
                        .tokens > 0 and
                        any(.breakdown[]?;
                            .kind == "model" and
                            any(.providers[]?;
                                .provider == $provider and .credits > 0
                            )
                        )
                    )
                ' <<<"$last_record" >/dev/null; then
            printf '%s\n' "$last_record"
            return 0
        fi
        sleep 2
    done

    echo "Timed out waiting for the usage record for thread ${thread_id}" >&2
    echo "Last usage record: ${last_record}" >&2
    return 1
}

runner_e2e_assert_no_usage_for_thread() {
    local thread_id="$1"
    local run_id="$2"
    local observation_seconds="${3:-10}"
    local started_at=$SECONDS
    local events record

    while :; do
        events=$(runner_chat_event_rows "$thread_id") || return
        record=$(runner_e2e_usage_record) || return
        if ! jq -e --arg runId "$run_id" '
            all(.rows[]?;
                .runId != $runId or .eventType != "usage.recorded"
            )
        ' <<<"$events" >/dev/null; then
            echo "Run ${run_id} unexpectedly emitted a usage event: ${events}" >&2
            return 1
        fi
        if ! jq -e --arg threadId "$thread_id" '
            all(.rows[]?; .threadId != $threadId)
        ' <<<"$record" >/dev/null; then
            echo "Thread ${thread_id} unexpectedly appeared in usage records: ${record}" >&2
            return 1
        fi
        if ((SECONDS - started_at >= observation_seconds)); then
            break
        fi
        sleep 2
    done

    jq -cn --arg runId "$run_id" --arg threadId "$thread_id" \
        '{runId: $runId, threadId: $threadId, usageCredits: 0}'
}

runner_e2e_network_logs() {
    local run_id="$1"
    runner_e2e_collect_pages "/api/runs/${run_id}/network" networkLogs
}

runner_e2e_collect_pages() {
    local path="$1"
    local collection_key="$2"
    local accumulated='[]'
    local cursor=""
    local encoded_cursor
    local has_more
    local next_cursor
    local page

    local page_number
    for ((page_number = 1; page_number <= 50; page_number += 1)); do
        local query="?limit=100&order=asc"
        if [[ -n "$cursor" ]]; then
            encoded_cursor=$(jq -rn --arg cursor "$cursor" '$cursor | @uri')
            query="${query}&cursor=${encoded_cursor}"
        fi
        page=$(runner_api_curl "${path}${query}") || return
        accumulated=$(jq -c \
            --arg collectionKey "$collection_key" \
            --argjson accumulated "$accumulated" \
            '$accumulated + .[$collectionKey]' \
            <<<"$page") || return
        has_more=$(jq -r \
            'if (.hasMore | type) == "boolean" then .hasMore else error("invalid hasMore") end' \
            <<<"$page") || {
            echo "Runner E2E telemetry returned an invalid page: $page" >&2
            return 1
        }
        if [[ "$has_more" != "true" ]]; then
            printf '%s\n' "$accumulated"
            return 0
        fi
        next_cursor=$(jq -er '.nextCursor | select(type == "string" and length > 0)' <<<"$page") || {
            echo "Runner E2E telemetry page is missing nextCursor: $page" >&2
            return 1
        }
        cursor="$next_cursor"
    done

    echo "Runner E2E telemetry exceeded 50 pages for ${path}" >&2
    return 1
}

runner_e2e_wait_for_chat_text() {
    local thread_id="$1"
    local run_id="$2"
    local expected="$3"
    local timeout_seconds="${4:-90}"
    local started_at=$SECONDS
    local last_events='{}'
    local matched_text=""

    while ((SECONDS - started_at < timeout_seconds)); do
        if last_events=$(runner_chat_event_rows "$thread_id" 2>&1) &&
            matched_text=$(jq -er --arg runId "$run_id" --arg expected "$expected" '
                [
                    .rows[]?
                    | select(.eventType == "output.message" and .runId == $runId)
                    | .payload.content
                    | select(type == "string" and contains($expected))
                ]
                | last // empty
            ' <<<"$last_events"); then
            printf '%s\n' "$matched_text"
            return 0
        fi
        sleep 2
    done

    echo "Timed out waiting for ${expected@Q} in chat output for run ${run_id}" >&2
    echo "Last chat events: ${last_events}" >&2
    return 1
}

runner_e2e_wait_for_active_chat_text() {
    local thread_id="$1"
    local run_id="$2"
    local expected="$3"
    local timeout_seconds="${4:-90}"
    local started_at=$SECONDS
    local last_events='{}'
    local last_run='{}'
    local matched_text=""
    local run_status=""

    while ((SECONDS - started_at < timeout_seconds)); do
        if last_events=$(runner_chat_event_rows "$thread_id" 2>&1) &&
            matched_text=$(jq -er --arg runId "$run_id" --arg expected "$expected" '
                [
                    .rows[]?
                    | select(.eventType == "output.message" and .runId == $runId)
                    | .payload.content
                    | select(type == "string" and contains($expected))
                ]
                | last // empty
            ' <<<"$last_events"); then
            printf '%s\n' "$matched_text"
            return 0
        fi

        if last_run=$(runner_api_curl "/api/runs/${run_id}" 2>&1); then
            run_status=$(jq -r '.status // empty' <<<"$last_run")
            case "$run_status" in
                completed|failed|timeout|cancelled)
                    echo "Run ${run_id} reached terminal status ${run_status@Q} before ${expected@Q} was visible" >&2
                    echo "Last chat events: ${last_events}" >&2
                    echo "Last run response: ${last_run}" >&2
                    return 1
                    ;;
            esac
        fi
        sleep 2
    done

    echo "Timed out waiting for active-run ${expected@Q} in chat events for run ${run_id}" >&2
    echo "Last chat events: ${last_events}" >&2
    echo "Last run response: ${last_run}" >&2
    return 1
}

runner_e2e_wait_for_firewall_log() {
    local run_id="$1"
    local firewall_name="$2"
    local host="$3"
    local expected_secrets="$4"
    local expected_url_rewrite="${5:-ignore}"
    local timeout_seconds="${6:-90}"
    local started_at=$SECONDS
    local last_logs='[]'
    local failed_logs='[]'

    while ((SECONDS - started_at < timeout_seconds)); do
        if last_logs=$(runner_e2e_network_logs "$run_id" 2>&1); then
            if jq -e \
                --arg firewallName "$firewall_name" \
                --arg host "$host" \
                --arg expectedUrlRewrite "$expected_url_rewrite" \
                --argjson expectedSecrets "$expected_secrets" \
                'any(.[];
                    .firewall_name == $firewallName and
                    .host == $host and
                    .action == "ALLOW" and
                    (.firewall_error // null) == null and
                    (((.auth_resolved_secrets // []) | sort) == ($expectedSecrets | sort)) and
                    ($expectedUrlRewrite == "ignore" or
                        .auth_url_rewrite == ($expectedUrlRewrite == "true")))' \
                <<<"$last_logs" >/dev/null; then
                printf '%s\n' "$last_logs"
                return 0
            fi

            if failed_logs=$(jq -ce \
                --arg firewallName "$firewall_name" \
                --arg host "$host" '
                    [ .[]
                    | select(
                        .firewall_name == $firewallName and
                        .host == $host and
                        (.firewall_error // null) != null
                    ) ]
                    | select(length > 0)' \
                <<<"$last_logs"); then
                echo "Firewall ${firewall_name@Q} on ${host@Q} reported an error for run ${run_id}" >&2
                echo "Matching network telemetry: ${failed_logs}" >&2
                echo "Last network telemetry: ${last_logs}" >&2
                return 1
            fi
        fi
        sleep 2
    done

    echo "Timed out waiting for firewall ${firewall_name@Q} on ${host@Q} for run ${run_id}" >&2
    echo "Last network telemetry: ${last_logs}" >&2
    return 1
}

runner_e2e_wait_for_firewall_transition() {
    local run_id="$1"
    local firewall_name="$2"
    local host="$3"
    local method="$4"
    local url="$5"
    local permission="$6"
    local timeout_seconds="${7:-90}"
    local started_at=$SECONDS
    local last_logs='[]'

    while ((SECONDS - started_at < timeout_seconds)); do
        if last_logs=$(runner_e2e_network_logs "$run_id" 2>&1) &&
            jq -e \
                --arg firewallName "$firewall_name" \
                --arg host "$host" \
                --arg method "$method" \
                --arg url "$url" \
                --arg permission "$permission" '
                    [
                        to_entries[]
                        | select(
                            .value.firewall_name == $firewallName and
                            .value.host == $host and
                            .value.method == $method and
                            .value.url == $url and
                            .value.firewall_permission == $permission
                        )
                    ] as $matching
                    | any($matching[];
                        . as $denied
                        | $denied.value.action == "DENY" and
                            $denied.value.status == 403 and
                            any($matching[];
                                .key > $denied.key and .value.action == "ALLOW"
                            )
                    )
                ' <<<"$last_logs" >/dev/null; then
            printf '%s\n' "$last_logs"
            return 0
        fi
        sleep 2
    done

    echo "Timed out waiting for firewall transition ${firewall_name@Q} on ${url@Q} for run ${run_id}" >&2
    echo "Last network telemetry: ${last_logs}" >&2
    return 1
}
