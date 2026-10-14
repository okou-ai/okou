#!/usr/bin/env bats

load '../../helpers/setup'
load '../../helpers/runner-chat'
load '../../helpers/runner-api'

setup() {
    runner_e2e_use_mock_codex_profile
    runner_e2e_require_environment
}

@test "WSS admits an owner ticket, serves reverse diagnostics and notices, and rejects consumed tickets" {
    run pnpm exec tsx scripts/runner-wss.ts
    echo "$output"
    assert_success
    run jq -e '.result == "PASS" and .tlsVerification == true and .schemaVersion == 1 and .reverseCalls == 12 and .noticesReceived >= 1 and .replayRejectedBeforeExpiry == true and .ownedCleanup == "PASS"' <<<"$output"
    assert_success
}
