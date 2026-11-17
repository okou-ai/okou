import ChatData
import ChatDataTestSupport
import ChatDomain
import SwiftUI
import XCTest

@testable import Okou

@MainActor
final class FailureBillingRecoveryTests: XCTestCase {
  func testBillingUsesServerCapabilitiesAndMemberPermissions() async throws {
    let fixture = FailureRecoveryFixture(
      reason: "insufficient_credits", error: "insufficient_credits")
    let (conversation, models) = await fixture.conversation()
    defer {
      conversation.close()
      models.close()
    }
    let failure = try XCTUnwrap(conversation.messages.last?.failure)
    let initial = await conversation.readFailureState(failure)
    XCTAssertTrue(try XCTUnwrap(initial.billing).canManageBilling)
    fixture.state.value.withLock {
      $0.billingAdmin = false
      $0.canBuyCredits = false
    }
    await conversation.refreshFailureAccounts()
    let member = await conversation.readFailureState(failure)
    let billing = try XCTUnwrap(member.billing)
    XCTAssertFalse(billing.canManageBilling)
    XCTAssertFalse(billing.canBuyCredits)
    XCTAssertTrue(
      AssistantFailureCopy.content(member).description.contains("admin")
    )
    await conversation.recoverFailure(failure.id)
    XCTAssertTrue(fixture.state.value.withLock { $0.sends.isEmpty })
    fixture.state.value.withLock {
      $0.credits = 100
      $0.canBuyCredits = true
    }
    await conversation.refreshFailureAccounts()
    let funded = await conversation.readFailureState(failure)
    XCTAssertEqual(AssistantFailureCopy.content(funded).title, "Credits available")
    conversation.draft = "A new input"
    await conversation.send()
    let historical = conversation.failureState(failure)
    XCTAssertFalse(historical.isCurrent)
    XCTAssertFalse(AssistantFailureCopy.content(historical).description.contains("Checking"))
  }

  func testRetiringBillingContextCancelsOriginalHTTPAndPreventsFutureReads() async throws {
    let fixture = FailureRecoveryFixture(reason: "insufficient_credits", error: "No credits")
    let (conversation, models) = await fixture.conversation()
    defer {
      conversation.close()
      models.close()
    }
    let owner = UUID()
    conversation.setDetailVisible(true, owner: owner)
    let gate = ModelResponseGate()
    let began = expectation(description: "Billing HTTP began")
    let cancelled = expectation(description: "Billing HTTP cancelled at its original transport")
    fixture.state.value.withLock {
      $0.billingGate = gate
      $0.billingRequested = { began.fulfill() }
      $0.billingCancelled = { cancelled.fulfill() }
    }
    let read = Task { await conversation.refreshFailureAccounts() }
    addTeardownBlock {
      read.cancel()
      gate.open()
      await read.value
    }
    await fulfillment(of: [began], timeout: 3)
    let retired = try XCTUnwrap(conversation.failureContext)
    conversation.setDetailVisible(false, owner: owner)
    await fulfillment(of: [cancelled], timeout: 3)
    gate.open()
    await read.value
    XCTAssertThrowsError(try retired.retry()) { XCTAssertTrue($0 is CancellationError) }
    XCTAssertThrowsError(try retired.store.get(XCTUnwrap(retired.billing)))
    await conversation.refreshFailureAccounts()
    await conversation.recoverFailure(FailureRecoveryFixture.failureID)
    let failure = try XCTUnwrap(conversation.messages.last?.failure)
    let state = await conversation.readFailureState(failure)
    XCTAssertFalse(state.isCurrent)
    XCTAssertNil(state.billing)
    XCTAssertTrue(fixture.state.value.withLock { $0.sends.isEmpty })
  }

  func testAccountReadFailureDoesNotBecomeBillingAuthorityAndRetriesStayReadOnly() async throws {
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
      XCTAssertNil(unavailable.billingError)
      XCTAssertNil(unavailable.billing)
      fixture.state.value.withLock { $0.accountStatus = 200 }
      await conversation.refreshFailureAccounts()
      let recovered = await conversation.readFailureState(failure)
      XCTAssertEqual(recovered.resetAccountID, ModelHTTPFixtures.accountID)
      XCTAssertTrue(fixture.state.value.withLock { $0.resetKeys.isEmpty && $0.sends.isEmpty })
    }
  }

  func testBillingFailureRevokesCapabilitiesUntilItsOwnReadSucceeds() async throws {
    let fixture = FailureRecoveryFixture(reason: "insufficient_credits", error: "No credits")
    let (conversation, models) = await fixture.conversation()
    defer {
      conversation.close()
      models.close()
    }
    let failure = try XCTUnwrap(conversation.messages.last?.failure)
    fixture.state.value.withLock { $0.billingStatus = 403 }
    await conversation.refreshFailureAccounts()
    let unavailable = await conversation.readFailureState(failure)
    XCTAssertNil(unavailable.billing)
    XCTAssertNotNil(unavailable.billingError)
    XCTAssertNil(unavailable.accountError)
    fixture.state.value.withLock {
      $0.billingStatus = 200
      $0.billingAdmin = false
    }
    await conversation.refreshFailureAccounts()
    let recovered = await conversation.readFailureState(failure)
    XCTAssertFalse(try XCTUnwrap(recovered.billing).canManageBilling)
    XCTAssertNil(recovered.billingError)
    XCTAssertTrue(fixture.state.value.withLock { $0.resetKeys.isEmpty && $0.sends.isEmpty })
  }

  func testBillingUpgradeBlocksRecoveryWithoutChangingTranscript() async throws {
    let fixture = FailureRecoveryFixture(reason: "insufficient_credits", error: "No credits")
    let (conversation, models) = await fixture.conversation()
    defer {
      conversation.close()
      models.close()
    }
    let failure = try XCTUnwrap(conversation.messages.last?.failure)
    let messages = conversation.messages
    fixture.state.value.withLock { $0.billingStatus = 426 }
    await conversation.refreshFailureAccounts()
    try await waitForBusinessResult { conversation.needsUpgrade }
    let context = try XCTUnwrap(conversation.failureContext)
    let original = try context.store.get(XCTUnwrap(context.billing))
    guard case .failure(let error) = await original.result else {
      return XCTFail("The original billing resource must retain the upgrade failure")
    }
    XCTAssertEqual((error as? APIClientError)?.statusCode, 426)
    let blocked = await conversation.readFailureState(failure)
    XCTAssertFalse(blocked.isCurrent)
    XCTAssertNil(blocked.billing)
    XCTAssertNil(blocked.resetAccountID)
    fixture.state.value.withLock { $0.billingStatus = 200 }
    await conversation.refreshFailureAccounts()
    await conversation.recoverFailure(failure.id)
    XCTAssertEqual(conversation.messages, messages)
    XCTAssertTrue(fixture.state.value.withLock { $0.resetKeys.isEmpty && $0.sends.isEmpty })
    conversation.close()
    XCTAssertThrowsError(try context.store.get(XCTUnwrap(context.billing)))
  }
}
