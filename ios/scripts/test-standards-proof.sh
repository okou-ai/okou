#!/usr/bin/env bash
set -euo pipefail
proof_root="$RUNNER_TEMP/ios-test-standards-proof"

# Any accidental display dependency fails the selected business suites.
python3 - <<'PY_GUARD'
from pathlib import Path
path = Path("ios/OkouTests/ConversationViewTestSupport.swift")
source = path.read_text()
needle = "func hostingPresentationFrame() async {"
assert source.count(needle) == 1
path.write_text(source.replace(needle, needle + '\n  XCTFail("Business tests must not await display frames")'))
PY_GUARD

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

suites=(AttachmentDraftTests ChatSyncRecoveryTests ChatThreadActionsTests ChatThreadPinTests
  ConnectorActionTests FailureRecoveryTests GeneratedResultTests MessageAttachmentTests
  SubscriptionAuthorizationTests WorkspaceStoreTests ChatSearchUnreadTests)
selections=()
for suite in "${suites[@]}"; do
  selections+=("-only-testing:OkouTests/$suite")
done
for attempt in 1 2 3 4 5; do
  run_native "${selections[@]}" -resultBundlePath "$proof_root/positive-$attempt.xcresult" \
    2>&1 | tee "$proof_root/positive-$attempt.log"
  swift test --package-path ios/Packages/ChatData \
    --scratch-path "$RUNNER_TEMP/okou-ios-ci/ChatData" --filter ChatSyncTests \
    2>&1 | tee "$proof_root/package-$attempt.log"
done

# The ordering regression must fail if opening no longer joins the current refresh.
python3 - <<'PY_MUTATE'
from pathlib import Path
path = Path("ios/Okou/App/WorkspaceStore.swift")
source = path.read_text()
needle = "if needsRefresh { await list.refresh(waitForCurrent: true) }"
assert source.count(needle) == 1
path.write_text(source.replace(needle, "if needsRefresh { await list.refresh(waitForCurrent: false) }"))
PY_MUTATE
bash ios/scripts/ci-test.sh compile
set +e
run_native -only-testing:OkouTests/ChatSearchUnreadTests/testOpeningSearchResultAwaitsAnAlreadyRunningListRefresh \
  -resultBundlePath "$proof_root/search-mutation.xcresult" \
  2>&1 | tee "$proof_root/search-mutation.log"
mutation_status=${PIPESTATUS[0]}
set -e
if [[ "$mutation_status" -ne 65 ]]; then
  echo "Expected the mutated ordering contract to fail with XCTest exit 65; got $mutation_status" >&2
  exit 1
fi
python3 - "$proof_root/search-mutation.log" <<'PY_VERIFY'
from pathlib import Path
import sys
log = Path(sys.argv[1]).read_text()
assert "XCTAssertTrue failed" in log
assert "testOpeningSearchResultAwaitsAnAlreadyRunningListRefresh]' failed" in log
print("The ordering regression rejected the missing refresh join")
PY_VERIFY
