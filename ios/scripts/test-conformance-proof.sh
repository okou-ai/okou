#!/usr/bin/env bash
set -euo pipefail
proof_root="$RUNNER_TEMP/ios-test-conformance-proof"

bash ios/scripts/ci-test.sh prepare
bash ios/scripts/ci-test.sh compile
python3 ios/scripts/preboot-simulator.py

test_runs=("$RUNNER_TEMP"/okou-ios-ci/DerivedData/Build/Products/*.xctestrun)
test "${#test_runs[@]}" -eq 1
run_native() {
  xcodebuild -xctestrun "${test_runs[0]}" \
    -destination "$IOS_TEST_DESTINATION" \
    -parallel-testing-enabled NO \
    -maximum-concurrent-test-simulator-destinations 1 \
    -collect-test-diagnostics never "$@" test-without-building
}

suites=(AuthenticationScopeTests AuthenticationStartupTests NotificationExtensionTests NotificationTests
  ChatComposerWorkflowTests ChatThreadActionsTests ChatLinkNavigationTests ComposerDraftTests
  CacheDirectoryLifecycleProofTests)
selections=()
for suite in "${suites[@]}"; do
  selections+=("-only-testing:OkouTests/$suite")
done
for attempt in 1 2 3 4 5; do
  run_native "${selections[@]}" -resultBundlePath "$proof_root/positive-$attempt.xcresult" \
    2>&1 | tee "$proof_root/positive-$attempt.log"
  swift test --package-path ios/Packages/ChatData \
    --scratch-path "$RUNNER_TEMP/okou-ios-ci/ChatData" \
    --filter 'ChatCacheTests|ChatClientTests.testServerTimestamps|CacheDirectoryLifecycleProofTests' \
    2>&1 | tee "$proof_root/package-$attempt.log"
done

# Only the business-only phase forbids display callbacks; focused input bridge
# coverage above retains the native presentation boundary it needs.
python3 - <<'PY_GUARD'
from pathlib import Path
path = Path("ios/OkouTests/ConversationViewTestSupport.swift")
source = path.read_text()
needle = "func hostingPresentationFrame() async {"
assert source.count(needle) == 1
path.write_text(source.replace(needle, needle + '\n  XCTFail("Business tests must not await display frames")'))
PY_GUARD
bash ios/scripts/ci-test.sh compile
run_native \
  -only-testing:OkouTests/NotificationTests \
  -only-testing:OkouTests/NotificationExtensionTests \
  -only-testing:OkouTests/AuthenticationScopeTests \
  -only-testing:OkouTests/ChatThreadActionsTests \
  -only-testing:OkouTests/ChatLinkNavigationTests \
  -only-testing:OkouTests/ComposerDraftTests/testUnavailableRemoteAttachmentRetainsCanonicalPartUntilExplicitRemoval \
  -only-testing:OkouTests/ComposerDraftTests/testInterruptedLocalFileIsNeverRestoredAsUploadedAndMissingFileRetryFails \
  -only-testing:OkouTests/ComposerDraftTests/testRestartRestoresTextUploadedFilesAndRichDocumentWithoutCreatingAThread \
  -only-testing:OkouTests/ChatComposerWorkflowTests/testWorkflowHTTPFailureCanBeRetriedAndClosedWorkspaceRejectsLateResults \
  -only-testing:OkouTests/ChatComposerWorkflowTests/testQuotedNoteKeepsQuoteAndAttachmentAndRecordsOnlyTypedWorkflowAfterSend \
  -resultBundlePath "$proof_root/business-guard.xcresult" \
  2>&1 | tee "$proof_root/business-guard.log"

# The cold delegate case must detect omission of real authentication restoration.
python3 - <<'PY_MUTATE'
from pathlib import Path
path = Path("ios/Okou/Services/NotificationService.swift")
source = path.read_text()
needle = "if authentication.isLoading { await authentication.refresh() }"
assert source.count(needle) == 1
path.write_text(source.replace(needle, "// Experimental mutation: omit cold authentication restoration."))
PY_MUTATE
bash ios/scripts/ci-test.sh compile
set +e
run_native -only-testing:OkouTests/NotificationTests/testBackgroundLaunchRestoresAuthenticationBeforeRejectingUnavailableMembership \
  -resultBundlePath "$proof_root/cold-mutation.xcresult" \
  2>&1 | tee "$proof_root/cold-mutation.log"
mutation_status=${PIPESTATUS[0]}
set -e
if [[ "$mutation_status" -ne 65 ]]; then
  echo "Expected the missing restoration to fail with XCTest exit 65; got $mutation_status" >&2
  exit 1
fi
python3 - "$proof_root/cold-mutation.log" <<'PY_VERIFY'
from pathlib import Path
import sys
log = Path(sys.argv[1]).read_text()
assert "XCTAssertFalse failed" in log
assert "XCTAssertNotNil failed" in log
assert "testBackgroundLaunchRestoresAuthenticationBeforeRejectingUnavailableMembership]' failed" in log
print("The cold delegate contract rejected missing authentication restoration")
PY_VERIFY
