#!/usr/bin/env bats

load '../../helpers/setup'
load '../../helpers/runner-chat'
load '../../helpers/runner-api'

setup() {
    runner_e2e_use_mock_codex_profile
    runner_e2e_require_environment
}

@test "WSS admits an owner ticket, echoes Guest frames and rejects consumed tickets" {
    run pnpm exec tsx scripts/runner-wss.ts
    echo "$output"
    assert_success
    run jq -e '.result == "PASS" and .tlsVerification == true and .replayRejectedBeforeExpiry == true and .ownedCleanup == "PASS"' <<<"$output"
    assert_success
}
