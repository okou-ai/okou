import ChatDomain
import XCTest

@testable import Okou

final class AssistantRunFailureCopyTests: XCTestCase {
  func testStructuredFailuresShowTheirReasonWithoutRecoveryReads() {
    let cases = [
      ("provider_request_timeout", "The model response timed out"),
      ("provider_bad_request", "The model provider returned an error"),
      ("account_verification_required", "Claude account verification required"),
      ("provider_model_restricted", "Selected model isn't available")
    ]
    for (reason, title) in cases {
      let copy = AssistantFailureCopy.content(failureState(reason))
      XCTAssertEqual(copy.title, title, reason)
      XCTAssertFalse(copy.description.isEmpty, reason)
      XCTAssertNotEqual(copy.description, AssistantFailureCopy.content(failureState(nil)).description)
    }
  }

  func testOomRetriesWithoutOfferingModelOrAccountRecovery() {
    let state = failureState("guest_memory_oom_killed")
    XCTAssertEqual(state.recovery.kind, .retryable)
    XCTAssertTrue(state.recovery.canRetry)
    XCTAssertFalse(state.showsModelPicker)
    XCTAssertNil(state.recovery.framework)
    XCTAssertNil(state.resetAccountID)
    XCTAssertEqual(AssistantFailureCopy.content(state).description, "Oops, something went wrong.")
  }

  func testMissingAndFutureTokensKeepGenericCopyAndConservativeActions() {
    let generic = AssistantFailureCopy.content(failureState("unknown"))
    for reason: String? in [nil, "future_reason"] {
      let state = failureState(reason)
      let copy = AssistantFailureCopy.content(state)
      XCTAssertEqual(state.failure.reason, reason)
      XCTAssertEqual(copy.title, generic.title)
      XCTAssertEqual(copy.description, generic.description)
      XCTAssertFalse(state.recovery.canRetry)
      XCTAssertFalse(state.showsModelPicker)
    }
  }

  private func failureState(_ reason: String?) -> AssistantFailureState {
    let failure = ChatFailure(id: "failed", runFailureReason: reason)
    return AssistantFailureState(
      failure: failure, recovery: failure.recovery(personalFramework: .codex),
      isCurrent: true, isBusy: false, canSend: true, accountLabel: nil, disconnected: false,
      resetDetails: [], resetAccountID: nil, resetsRemaining: 0, accountError: nil)
  }
}
