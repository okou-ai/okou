#!/usr/bin/env bats

# Deployed runner toolchain smoke through the public chat API.
# Use the native Codex mock so shell stdout is not paraphrased by a real model.

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

@test "deployed runner executes gh and reads a local page with Chromium" {
    run create_runner_agent "e2e-runner-toolchain-browser-${TEST_ID}"
    echo "$output"
    assert_success
    AGENT_ID="$output"

    local browser_marker="RUNNER_BROWSER_DOM_${TEST_ID}"
    local output_marker="RUNNER_TOOLCHAIN_OK_${TEST_ID}"
    local prompt
    prompt=$(cat <<'EOF'
set -euo pipefail

gh_version="$(gh --version | sed -n '1p')"
grep -Eq '^gh version [0-9]+\.[0-9]+\.[0-9]+([.-][[:alnum:].-]+)?([[:space:]]|$)' <<<"$gh_version"

browser_session="runner-toolchain-__TEST_ID__"
browser_marker="__BROWSER_MARKER__"
browser_url="data:text/html,%3Cmain%20id%3D%22runner-toolchain-marker%22%3E${browser_marker}%3C%2Fmain%3E"
trap 'agent-browser --session "$browser_session" close >/dev/null 2>&1 || true' EXIT
agent-browser --session "$browser_session" open "$browser_url"
dom_marker="$(agent-browser --session "$browser_session" get text '#runner-toolchain-marker')"
test "$dom_marker" = "$browser_marker"
agent-browser --session "$browser_session" close >/dev/null
trap - EXIT

printf 'GH_VERSION_OK=%s\n' "$gh_version"
printf 'BROWSER_DOM_OK=%s\n' "$dom_marker"
printf '__OUTPUT_MARKER__\n'
EOF
)
    prompt=${prompt//__TEST_ID__/$TEST_ID}
    prompt=${prompt//__BROWSER_MARKER__/$browser_marker}
    prompt=${prompt//__OUTPUT_MARKER__/$output_marker}

    run runner_e2e_start_chat_run "$AGENT_ID" "$prompt"
    echo "$output"
    assert_success
    RUN_ID=$(jq -er '.runId | select(type == "string" and length > 0)' <<<"$output")
    THREAD_ID=$(jq -er '.threadId | select(type == "string" and length > 0)' <<<"$output")

    run runner_wait_for_run "$RUN_ID" 180
    echo "$output"
    assert_success

    run runner_e2e_wait_for_chat_text \
        "$THREAD_ID" \
        "$RUN_ID" \
        "$output_marker"
    echo "$output"
    assert_success
    assert_output --regexp 'GH_VERSION_OK=gh version [0-9]+\.[0-9]+\.[0-9]+'
    assert_output --partial "BROWSER_DOM_OK=${browser_marker}"
}
