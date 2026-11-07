import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class ConversationRefreshTests: XCTestCase {
  func testNewMessagesPublishBeforeCancellationRecoveryFinishes() async throws {
    let gate = ModelResponseGate()
    let held = Mutex(false)
    let recoveryStarted = expectation(description: "Recovery read is pending")
    let fixture = ConversationHistoryFixture(
      count: 2,
      detail: { _ in
        if held.withLock({ $0 }) {
          recoveryStarted.fulfill()
          await gate.wait()
        }
        return ChatHTTPResponse(body: #"{"cancellationRecoveryPending":true}"#)
      })
    let conversation = fixture.conversation()
    await conversation.refresh()
    XCTAssertEqual(conversation.history?.executionState, .recovering)
    fixture.appendMessage()
    held.withLock { $0 = true }
    let refresh = Task { await conversation.refresh() }
    addTeardownBlock { @MainActor in
      conversation.close()
      refresh.cancel()
      gate.open()
      await refresh.value
    }
    await fulfillment(of: [recoveryStarted], timeout: 3)
    try await waitForBusinessResult { conversation.messages.count == 3 }
    XCTAssertEqual(conversation.history?.executionState, .recovering)
    gate.open()
    await refresh.value
    XCTAssertNil(conversation.syncError)
  }

  func testRecoveryFailureKeepsFreshMessagesAndLaterClearsConfirmedRecovery() async throws {
    let outcome = Mutex(0)
    let fixture = ConversationHistoryFixture(
      count: 2,
      detail: { _ in
        switch outcome.withLock({ $0 }) {
        case 0: return ChatHTTPResponse(body: #"{"cancellationRecoveryPending":true}"#)
        case 1: return ChatHTTPResponse(status: 403, body: #"{"error":{"message":"Unavailable"}}"#)
        default: return ChatHTTPResponse(body: #"{"cancellationRecoveryPending":false}"#)
        }
      })
    let conversation = fixture.conversation()
    defer { conversation.close() }
    await conversation.refresh()
    fixture.appendMessage()
    outcome.withLock { $0 = 1 }
    await conversation.refresh()
    XCTAssertEqual(conversation.messages.count, 3)
    XCTAssertEqual(conversation.history?.executionState, .recovering)
    XCTAssertNotNil(conversation.syncError)
    outcome.withLock { $0 = 2 }
    await conversation.refresh()
    XCTAssertEqual(conversation.messages.count, 3)
    XCTAssertEqual(conversation.history?.executionState, .queued)
    XCTAssertNil(conversation.syncError)
  }
}
