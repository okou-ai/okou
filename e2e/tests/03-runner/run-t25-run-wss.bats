#!/usr/bin/env bats

load '../../helpers/setup'
load '../../helpers/runner-chat'
load '../../helpers/runner-api'

setup() {
    runner_e2e_use_mock_codex_profile
    runner_e2e_require_environment
}

@test "WSS and native HTTPS downloads serve owned bytes and reject replay and retired Runs" {
    run pnpm exec tsx scripts/runner-wss.ts
    echo "$output"
    assert_success
    run jq -e '.result == "PASS" and .tlsVerification == true and .schemaVersion == 1 and .reverseCalls == 12 and .noticesReceived >= 1 and .replayRejectedBeforeExpiry == true and .ownedCleanup == "PASS" and .filesystemVersion == 3 and .fileReadBytes == 70003 and (.fileReadSha256 | test("^[0-9a-f]{64}$")) and .readerRelease == true and .prefixPreviewBytes == 65536 and .readerAbandonedToConnection == true' <<<"$output"
    assert_success
    run jq -e '.nativeDownloadBytes == 134287731 and .nativeDownloadChunks > 1 and .nativeDownloadHashes == "PASS" and .nativeDownloadReplay == "rejected" and .nativeDownloadMethodAndPath == "rejected" and .nativeDownloadRunEnd == "interrupted" and .nativeDownloadInterruptedBytes < 134217728 and .downloadClientPeakRss >= .downloadClientStartRss' <<<"$output"
    assert_success
}
