#!/usr/bin/env bats

load '../../helpers/setup'
load '../../helpers/runner-chat'
load '../../helpers/runner-api'

setup_file() {
    pnpm exec playwright install --only-shell chromium
}

setup() {
    runner_e2e_use_mock_codex_profile
    runner_e2e_require_environment
    export OKOU_API_BACKEND_URL="$E2E_API_URL"
    local app_url
    app_url="$(jq -er '.appUrl | select(type == "string" and length > 0)' /tmp/e2e-api-credentials-runner-mock-claude.json)"
    export OKOU_APP_URL="$app_url"
}

@test "trusted browser WSS echoes Guest frames and loses access after Run termination" {
    run pnpm exec tsx playwright/runner-wss.ts
    echo "$output"
    assert_success
    run jq -e '.result == "PASS" and .tlsVerification == true and .ownedCleanup == "PASS"' <<<"$output"
    assert_success
}
