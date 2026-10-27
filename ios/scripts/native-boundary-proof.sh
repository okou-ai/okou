#!/usr/bin/env bash
set -euo pipefail
proof_root="$RUNNER_TEMP/ios-native-boundary-proof"
bash ios/scripts/ci-test.sh prepare
bash ios/scripts/ci-test.sh compile
python3 ios/scripts/preboot-simulator.py

test_run=$(python3 -c 'import glob,os; paths=glob.glob(os.environ["RUNNER_TEMP"]+"/okou-ios-ci/DerivedData/Build/Products/*.xctestrun"); assert len(paths)==1; print(paths[0])')
run_native() {
  xcodebuild -xctestrun "$test_run" \
    -destination "$IOS_TEST_DESTINATION" \
    -parallel-testing-enabled NO \
    -maximum-concurrent-test-simulator-destinations 1 \
    -collect-test-diagnostics never "$@" test-without-building
}
for attempt in 1 2 3 4 5; do
  run_native \
    -only-testing:OkouTests/RecommendedFollowupTests \
    -only-testing:OkouTests/ComposerDraftTests \
    -only-testing:OkouTests/ChatComposerMentionTests \
    -only-testing:OkouTests/ChatComposerWorkflowTests \
    -resultBundlePath "$proof_root/positive-$attempt.xcresult" \
    2>&1 | tee "$proof_root/positive-$attempt.log"
done

# The newly separated business contracts must pass without any display frames.
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
  -only-testing:OkouTests/ComposerDraftTests/testRichQuoteAndAttachmentsRoundTripRestartAndRemoteConflictChoice \
  -only-testing:OkouTests/ComposerDraftTests/testRichDraftConflictKeepsLocalTextReferencesAndAttachments \
  -only-testing:OkouTests/ComposerDraftTests/testQuotedDraftRoundTripsNotesSourcesOrderAndConflictRecovery \
  -only-testing:OkouTests/ComposerDraftTests/testRestartRestoresTextUploadedFilesAndRichDocumentWithoutCreatingAThread \
  -only-testing:OkouTests/ChatComposerMentionTests/testQuotedNotesMixReferencesAndAttachmentsWithoutChangingQuoteSource \
  -only-testing:OkouTests/ChatComposerWorkflowTests/testWorkflowHTTPFailureCanBeRetriedAndClosedWorkspaceRejectsLateResults \
  -only-testing:OkouTests/ChatComposerWorkflowTests/testQuotedNoteKeepsQuoteAndAttachmentAndRecordsOnlyTypedWorkflowAfterSend \
  -resultBundlePath "$proof_root/business-guard.xcresult" \
  2>&1 | tee "$proof_root/business-guard.log"
