import ChatDataTestSupport
import ChatDomain
import XCTest

@testable import Okou

@MainActor
final class FailureBillingRecoveryTests: XCTestCase {
  func testInsufficientCreditsExplainsTheFailureWithoutStartingAnotherRun() async throws {
    let fixture = FailureRecoveryFixture(
      reason: "insufficient_credits", error: "insufficient_credits")
    let (conversation, models) = await fixture.conversation()
    defer {
      conversation.close()
      models.close()
    }

    let failure = try XCTUnwrap(conversation.messages.last?.failure)
    let state = await conversation.readFailureState(failure)
    let copy = AssistantFailureCopy.content(state)
    XCTAssertEqual(copy.title, "Out of credits")
    XCTAssertEqual(copy.description, "The workspace did not have enough credits for this run.")
    XCTAssertTrue(state.isCurrent)
    XCTAssertFalse(state.recovery.canRetry)
    XCTAssertFalse(state.showsModelPicker)
    await conversation.recoverFailure(failure.id)
    XCTAssertTrue(fixture.state.value.withLock { $0.sends.isEmpty })

    conversation.draft = "A new input"
    await conversation.send()
    let historical = conversation.failureState(failure)
    XCTAssertFalse(historical.isCurrent)
    XCTAssertEqual(AssistantFailureCopy.content(historical).description, copy.description)
  }

  func testLegacyPlanRestrictionHasAnExplanationWithoutAPurchaseAction() {
    let failure = ChatFailure(id: "old", outputError: " PRO_REQUIRED ")
    let state = AssistantFailureState.make(
      failure: failure, current: true, selection: nil, accounts: nil, busy: false)
    XCTAssertEqual(AssistantFailureCopy.content(state).title, "Plan restricted")
    XCTAssertFalse(state.recovery.canRetry)
    XCTAssertFalse(state.showsModelPicker)
  }

  func testAccountFailureRetriesStayReadOnly() async throws {
    for status in [401, 403, 426] {
      let fixture = FailureRecoveryFixture(reason: "usage_limit", error: "Usage limit")
      let (conversation, models) = await fixture.conversation()
      defer {
        conversation.close()
        models.close()
      }
      let failure = try XCTUnwrap(conversation.messages.last?.failure)
      fixture.state.value.withLock { $0.accountStatus = status }
      await conversation.refreshFailureAccounts()
      let unavailable = await conversation.readFailureState(failure)
      XCTAssertNotNil(unavailable.accountError)
      XCTAssertNil(unavailable.resetAccountID)
      fixture.state.value.withLock { $0.accountStatus = 200 }
      await conversation.refreshFailureAccounts()
      let recovered = await conversation.readFailureState(failure)
      XCTAssertEqual(recovered.resetAccountID, ModelHTTPFixtures.accountID)
      XCTAssertTrue(fixture.state.value.withLock { $0.resetKeys.isEmpty && $0.sends.isEmpty })
    }
  }
}
