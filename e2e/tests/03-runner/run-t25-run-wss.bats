#!/usr/bin/env bats

load '../../helpers/setup'
load '../../helpers/runner-chat'
load '../../helpers/runner-api'

setup() {
    runner_e2e_use_mock_codex_profile
    runner_e2e_require_environment
    export OKOU_API_BACKEND_URL="$E2E_API_URL"
}

@test "trusted browser WSS echoes Guest frames and loses access after Run termination" {
    run pnpm exec tsx playwright/runner-wss.ts
    echo "$output"
    assert_success
    run jq -e '.result == "PASS" and .tlsVerification == true and .ownedCleanup == "PASS"' <<<"$output"
    assert_success
}
