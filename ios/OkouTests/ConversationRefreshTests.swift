import ChatData
import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class ConversationRefreshTests: XCTestCase {
  func testNewMessagesPublishBeforeCancellationRecoveryFinishes() async throws {
    let gate = ConversationResponseGate()
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
    let sync = ChatSync(client: fixture.http.client)
    let conversation = fixture.conversation(sharedSync: sync)
    defer { conversation.close() }
    await conversation.refresh()
    fixture.appendMessage()
    outcome.withLock { $0 = 1 }
    await conversation.refresh()
    XCTAssertEqual(conversation.messages.count, 3)
    XCTAssertEqual(conversation.history?.executionState, .recovering)
    XCTAssertNotNil(conversation.syncError)
    outcome.withLock { $0 = 2 }
    fixture.appendMessage()
    // A separate durable catch-up can warm newer input than the last resource Task.
    _ = try await sync.eventHistory(threadID: ConversationHistoryFixture.threadID)
    await conversation.refresh(read: .recovery)
    XCTAssertEqual(conversation.messages.count, 4)
    XCTAssertEqual(conversation.history?.executionState, .queued)
    XCTAssertNil(conversation.syncError)
  }

  func testFirstHistoryIsAvailableBeforeTheRecoveryEndpointCompletes() async throws {
    let response = ConversationResponseGate()
    let started = expectation(description: "Initial recovery is pending")
    let fixture = ConversationHistoryFixture(
      count: 1,
      detail: { _ in
        started.fulfill()
        await response.wait()
        return ChatHTTPResponse(body: #"{"cancellationRecoveryPending":false}"#)
      })
    let conversation = fixture.conversation()
    let refreshing = Task { await conversation.refresh() }
    addTeardownBlock { @MainActor in
      conversation.close()
      response.open()
      await refreshing.value
    }
    await fulfillment(of: [started], timeout: 3)
    let history = try await conversation.reads.store.get(conversation.reads.history).value
    try await waitForBusinessResult {
      conversation.messages.first?.id == history?.messages.first?.id
    }
    XCTAssertEqual(conversation.messages.first?.id, ConversationHistoryFixture.id(1))
    response.open()
    await refreshing.value
    XCTAssertNil(conversation.syncError)
  }

  func testHistoryFailureDoesNotDiscardRecoveryAndHistoryRetryRetainsThatConfirmation() async {
    let outcome = Mutex(0)
    let fixture = ConversationHistoryFixture(
      count: 0,
      eventRows: { _ in
        if outcome.withLock({ $0 }) == 1 {
          return ChatHTTPResponse(status: 403, body: #"{"error":{"message":"History denied"}}"#)
        }
        return ChatHTTPResponse(
          body: #"{"rows":[],"cursor":{"lastEventId":null,"lastSeqId":0},"hasMore":false}"#)
      },
      detail: { _ in
        switch outcome.withLock({ $0 }) {
        case 0: return ChatHTTPResponse(body: #"{"cancellationRecoveryPending":true}"#)
        case 1: return ChatHTTPResponse(body: #"{"cancellationRecoveryPending":false}"#)
        default:
          return ChatHTTPResponse(status: 403, body: #"{"error":{"message":"Recovery denied"}}"#)
        }
      })
    let conversation = fixture.conversation()
    defer { conversation.close() }
    await conversation.refresh()
    XCTAssertEqual(conversation.history?.executionState, .recovering)
    outcome.withLock { $0 = 1 }
    await conversation.refresh()
    XCTAssertEqual(conversation.history?.executionState, .idle)
    XCTAssertNotNil(conversation.syncError)
    outcome.withLock { $0 = 2 }
    await conversation.refresh(read: .history)
    XCTAssertEqual(conversation.history?.executionState, .idle)
    XCTAssertNil(conversation.syncError)
  }

  func testRetirementCancelsBothOriginalReadsAndRejectsFutureDemand() async throws {
    let response = ConversationResponseGate()
    let historyStarted = expectation(description: "History HTTP started")
    let recoveryStarted = expectation(description: "Recovery HTTP started")
    let historyCancelled = expectation(description: "History HTTP cancelled")
    let recoveryCancelled = expectation(description: "Recovery HTTP cancelled")
    let responsesFinished = expectation(description: "Retired HTTP handlers completed")
    responsesFinished.expectedFulfillmentCount = 2
    let fixture = ConversationHistoryFixture(
      count: 2,
      beforeEventRows: { _ in
        historyStarted.fulfill()
        await withTaskCancellationHandler {
          await response.wait()
        } onCancel: {
          historyCancelled.fulfill()
        }
        responsesFinished.fulfill()
      },
      detail: { _ in
        recoveryStarted.fulfill()
        await withTaskCancellationHandler {
          await response.wait()
        } onCancel: {
          recoveryCancelled.fulfill()
        }
        responsesFinished.fulfill()
        return ChatHTTPResponse(body: #"{"cancellationRecoveryPending":true}"#)
      })
    let conversation = fixture.conversation()
    let refreshing = Task { await conversation.refresh() }
    addTeardownBlock { @MainActor in
      conversation.close()
      response.open()
      await refreshing.value
    }
    await fulfillment(of: [historyStarted, recoveryStarted], timeout: 3)
    let originalHistory = try conversation.reads.store.get(conversation.reads.history)
    let originalRecovery = try conversation.reads.store.get(conversation.reads.recovery)
    conversation.close()
    await fulfillment(of: [historyCancelled, recoveryCancelled], timeout: 3)
    response.open()
    await fulfillment(of: [responsesFinished], timeout: 3)
    await refreshing.value
    do {
      _ = try await originalHistory.value
      XCTFail("Retired history must not publish")
    } catch is CancellationError {} catch { XCTFail("Unexpected history error: \(error)") }
    do {
      _ = try await originalRecovery.value
      XCTFail("Retired recovery must not publish")
    } catch is CancellationError {} catch { XCTFail("Unexpected recovery error: \(error)") }
    await conversation.refresh()
    XCTAssertNil(conversation.history)
    XCTAssertTrue(conversation.messages.isEmpty)
    XCTAssertThrowsError(try conversation.reads.store.get(conversation.reads.history))
    XCTAssertThrowsError(try conversation.reads.store.get(conversation.reads.recovery))
  }
}

/// HTTP handlers deliberately outlive cancellation until the test releases their response.
private final class ConversationResponseGate: Sendable {
  private struct State {
    var open = false
    var waiters: [CheckedContinuation<Void, Never>] = []
  }
  private let state = Mutex(State())

  func open() {
    let waiters = state.withLock { value in
      value.open = true
      let waiters = value.waiters
      value.waiters.removeAll()
      return waiters
    }
    for waiter in waiters { waiter.resume() }
  }

  func wait() async {
    await withCheckedContinuation { continuation in
      state.withLock { value in
        if value.open { continuation.resume() } else { value.waiters.append(continuation) }
      }
    }
  }
}
