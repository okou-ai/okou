#!/usr/bin/env bash

# Source after runner-chat.bash. Only the Codex continuity test uses this helper.
# Success is silent and performs no I/O beyond parsing the two captured summaries.
# Optional failure evidence never retries or changes a failed assertion's result.
runner_chat_assert_codex_continuity() {
    local first_output="$1" second_output="$2"
    local filter first second
    filter="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/runner-session-diagnostics.jq"
    first="$(sed -n '1p' <<< "$first_output" |
        jq -sce --arg surface summary --arg runId '' -f "$filter" 2>/dev/null)" ||
        first='{"state":"unavailable"}'
    second="$(sed -n '1p' <<< "$second_output" |
        jq -sce --arg surface summary --arg runId '' -f "$filter" 2>/dev/null)" ||
        second='{"state":"unavailable"}'

    if jq -en --argjson first "$first" --argjson second "$second" '
        $first.state == "available" and $second.state == "available" and
        $first.threadId == $second.threadId and
        $first.sessionId == $second.sessionId
    ' >/dev/null; then
        return 0
    fi

    printf '# Codex session continuity mismatch\n# first: %s\n# second: %s\n' \
        "$first" "$second" >&2
    local turn summary run_id surface path snapshot response
    for turn in first second; do
        if [[ "$turn" == first ]]; then summary="$first"; else summary="$second"; fi
        run_id="$(jq -er '.runId // empty' <<< "$summary")" || continue
        for surface in run context initialization; do
            case "$surface" in
                run) path="/api/runs/${run_id}" ;;
                context) path="/api/runs/${run_id}/context" ;;
                initialization) path="/api/runs/${run_id}/telemetry/agent?limit=100&order=asc" ;;
            esac
            snapshot='{"state":"unavailable"}'
            # Limit actual received bytes as well as wall time. Discard HTTP
            # error bodies and stderr; both may contain private response data.
            if response="$(E2E_CURL_CONNECT_TIMEOUT_SECONDS=5 \
                E2E_CURL_MAX_TIME_SECONDS=5 \
                _runner_api_curl 1 "$path" --max-filesize 262144 2>/dev/null)"; then
                snapshot="$(jq -sce --arg surface "$surface" --arg runId "$run_id" \
                    -f "$filter" <<< "$response" 2>/dev/null)" ||
                    snapshot='{"state":"unavailable"}'
            fi
            printf '# %s %s: %s\n' "$turn" "$surface" "$snapshot" >&2
        done
    done
    # Public context/events are best effort. An empty first page is not proof
    # that native initialization did not occur; exact Run IDs enable log joins.
    return 1
}
