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

  func testHiddenDetailAndCancelledWaiterKeepResidentHistoryAndDraft() async throws {
    let began = expectation(description: "Resident history HTTP began")
    let gate = ModelResponseGate()
    let held = Mutex(false)
    let cancelled = Mutex(false)
    let visible = Mutex(true)
    let fixture = ConversationHistoryFixture(
      count: 2,
      beforeEventRows: { _ in
        guard
          held.withLock({ value in
            let first = !value
            value = true
            return first
          })
        else { return }
        await withTaskCancellationHandler {
          began.fulfill()
          await gate.wait()
        } onCancel: {
          cancelled.withLock { $0 = true }
        }
      })
    let conversation = fixture.conversation(isVisible: { visible.withLock { $0 } })
    let owner = UUID()
    conversation.setDetailVisible(true, owner: owner)
    conversation.draft = "Keep this unsent draft"
    let reading = Task { await conversation.refresh() }
    addTeardownBlock { @MainActor in
      conversation.close()
      reading.cancel()
      gate.open()
      await reading.value
    }
    await fulfillment(of: [began], timeout: 3)
    visible.withLock { $0 = false }
    conversation.setDetailVisible(false, owner: owner)
    reading.cancel()
    fixture.appendMessage()
    gate.open()
    await reading.value
    XCTAssertEqual(conversation.messages.last?.id, ConversationHistoryFixture.id(3))
    XCTAssertEqual(conversation.draft, "Keep this unsent draft")
    XCTAssertFalse(cancelled.withLock { $0 })
    XCTAssertNil(conversation.syncError)
  }

  func testPauseCancelsBothOriginalReadsAndLateRecoveryCannotReplaceForegroundHistory()
    async throws
  {
    let historyBegan = expectation(description: "History HTTP began")
    let recoveryBegan = expectation(description: "Recovery HTTP began")
    let historyCancelled = expectation(description: "Original history HTTP cancelled")
    let recoveryCancelled = expectation(description: "Original recovery HTTP cancelled")
    let retired = expectation(description: "Paused refresh returned")
    let historyGate = ConversationRefreshGate()
    let recoveryGate = ConversationRefreshGate()
    let historyFinished = ConversationRefreshGate()
    let recoveryFinished = ConversationRefreshGate()
    let heldHistory = Mutex(false)
    let heldRecovery = Mutex(false)
    let returned = Mutex(false)
    let fixture = ConversationHistoryFixture(
      count: 2,
      beforeEventRows: { _ in
        guard
          heldHistory.withLock({ value in
            let first = !value
            value = true
            return first
          })
        else { return }
        defer { historyFinished.open() }
        await withTaskCancellationHandler {
          historyBegan.fulfill()
          await historyGate.wait()
        } onCancel: {
          historyCancelled.fulfill()
        }
      },
      detail: { _ in
        let first = heldRecovery.withLock { value in
          let first = !value
          value = true
          return first
        }
        if first {
          defer { recoveryFinished.open() }
          await withTaskCancellationHandler {
            recoveryBegan.fulfill()
            await recoveryGate.wait()
          } onCancel: {
            recoveryCancelled.fulfill()
          }
        }
        return ChatHTTPResponse(
          body: first
            ? #"{"cancellationRecoveryPending":false}"#
            : #"{"cancellationRecoveryPending":true}"#)
      })
    let conversation = fixture.conversation()
    conversation.draft = "Draft survives background"
    let reading = Task {
      await conversation.refresh()
      returned.withLock { $0 = true }
      retired.fulfill()
    }
    addTeardownBlock { @MainActor in
      conversation.close()
      reading.cancel()
      historyGate.open()
      recoveryGate.open()
      await reading.value
      if heldHistory.withLock({ $0 }) { await historyFinished.wait() }
      if heldRecovery.withLock({ $0 }) { await recoveryFinished.wait() }
    }
    await fulfillment(of: [historyBegan, recoveryBegan], timeout: 3)
    conversation.cancelRefresh()
    await fulfillment(of: [historyCancelled, recoveryCancelled, retired], timeout: 3)
    guard returned.withLock({ $0 }) else { return }
    fixture.appendMessage()
    await conversation.refresh()
    XCTAssertEqual(conversation.messages.last?.id, ConversationHistoryFixture.id(3))
    XCTAssertEqual(conversation.history?.executionState, .recovering)
    historyGate.open()
    recoveryGate.open()
    await historyFinished.wait()
    await recoveryFinished.wait()
    await reading.value
    XCTAssertEqual(conversation.messages.last?.id, ConversationHistoryFixture.id(3))
    XCTAssertEqual(conversation.history?.executionState, .recovering)
    XCTAssertEqual(conversation.draft, "Draft survives background")
    XCTAssertNil(conversation.syncError)
  }

  func testCloseCancelsHistoryAndPreventsFutureReadsOrPublication() async throws {
    let began = expectation(description: "History HTTP began")
    let recoveryBegan = expectation(description: "Recovery HTTP began")
    let cancelled = expectation(description: "Close cancelled original history HTTP")
    let gate = ModelResponseGate()
    let fixture = ConversationHistoryFixture(
      count: 2,
      beforeEventRows: { _ in
        await withTaskCancellationHandler {
          began.fulfill()
          await gate.wait()
        } onCancel: {
          cancelled.fulfill()
        }
      },
      detail: { _ in
        recoveryBegan.fulfill()
        return ChatHTTPResponse(body: #"{"cancellationRecoveryPending":false}"#)
      })
    let conversation = fixture.conversation()
    let reading = Task { await conversation.refresh() }
    addTeardownBlock { @MainActor in
      conversation.close()
      reading.cancel()
      gate.open()
      await reading.value
    }
    await fulfillment(of: [began, recoveryBegan], timeout: 3)
    conversation.close()
    await fulfillment(of: [cancelled], timeout: 3)
    gate.open()
    await reading.value
    let completedRequests = fixture.requests.values.withLock { $0 }
    await conversation.refresh()
    XCTAssertEqual(fixture.requests.values.withLock { $0 }, completedRequests)
    XCTAssertTrue(conversation.messages.isEmpty)
    XCTAssertNil(conversation.history)
  }

  func testHistoryDenialsKeepConfirmedMessagesAndRequireExplicitRecovery() async throws {
    for status in [401, 403, 426] {
      let responseStatus = Mutex(200)
      let fixture = ConversationHistoryFixture(
        count: 2, eventRowsStatus: { responseStatus.withLock { $0 } })
      let conversation = fixture.conversation()
      defer { conversation.close() }
      await conversation.refresh()
      fixture.appendMessage()
      responseStatus.withLock { $0 = status }
      await conversation.refresh()
      XCTAssertEqual(conversation.messages.last?.id, ConversationHistoryFixture.id(2))
      XCTAssertNotNil(conversation.syncError)
      XCTAssertEqual(conversation.needsUpgrade, status == 426)
      responseStatus.withLock { $0 = 200 }
      XCTAssertNotNil(conversation.syncError)
      await conversation.refresh()
      if status == 426 {
        XCTAssertEqual(conversation.messages.last?.id, ConversationHistoryFixture.id(2))
        XCTAssertTrue(conversation.needsUpgrade)
      } else {
        XCTAssertEqual(conversation.messages.last?.id, ConversationHistoryFixture.id(3))
        XCTAssertNil(conversation.syncError)
      }
      XCTAssertTrue(fixture.requests.sentMessages.withLock { $0.isEmpty })
    }
  }

  func testHistoryFailureRetiresUnusedRecoveryWithoutWaitingForItsResponse() async throws {
    let began = expectation(description: "Independent recovery HTTP began")
    let cancelled = expectation(description: "Unused recovery HTTP cancelled")
    let returned = expectation(description: "History failure returned to the caller")
    let ready = ModelResponseGate()
    let response = ModelResponseGate()
    let fixture = ConversationHistoryFixture(
      count: 2, beforeEventRows: { _ in await ready.wait() }, eventRowsStatus: { 403 },
      detail: { _ in
        await withTaskCancellationHandler {
          began.fulfill()
          ready.open()
          await response.wait()
        } onCancel: {
          cancelled.fulfill()
        }
        return ChatHTTPResponse(body: #"{"cancellationRecoveryPending":false}"#)
      })
    let conversation = fixture.conversation()
    let reading = Task {
      await conversation.refresh()
      returned.fulfill()
    }
    addTeardownBlock { @MainActor in
      conversation.close()
      reading.cancel()
      ready.open()
      response.open()
      await reading.value
    }
    await fulfillment(of: [began, cancelled, returned], timeout: 3)
    XCTAssertNotNil(conversation.syncError)
    XCTAssertTrue(conversation.messages.isEmpty)
    response.open()
    await reading.value
  }

  func testRefreshRequestedDuringRecoveryPublishesTheNextHistoryCycle() async throws {
    let began = expectation(description: "First cycle recovery is pending")
    let response = ModelResponseGate()
    let held = Mutex(false)
    let fixture = ConversationHistoryFixture(
      count: 2,
      detail: { _ in
        if held.withLock({ value in
          let first = !value
          value = true
          return first
        }) {
          began.fulfill()
          await response.wait()
        }
        return ChatHTTPResponse(body: #"{"cancellationRecoveryPending":false}"#)
      })
    let conversation = fixture.conversation()
    let reading = Task { await conversation.refresh() }
    addTeardownBlock { @MainActor in
      conversation.close()
      reading.cancel()
      response.open()
      await reading.value
    }
    await fulfillment(of: [began], timeout: 3)
    try await waitForBusinessResult {
      conversation.messages.last?.id == ConversationHistoryFixture.id(2)
    }
    fixture.appendMessage()
    await conversation.refresh()
    response.open()
    await reading.value
    XCTAssertEqual(conversation.messages.last?.id, ConversationHistoryFixture.id(3))
    XCTAssertNil(conversation.syncError)
  }
}

/// The external server can finish after client cancellation; cleanup must release it.
private final class ConversationRefreshGate: Sendable {
  private struct State {
    var open = false
    var waiters: [CheckedContinuation<Void, Never>] = []
  }
  private let state = Mutex(State())

  func wait() async {
    await withCheckedContinuation { continuation in
      state.withLock { value in
        if value.open {
          continuation.resume()
        } else {
          value.waiters.append(continuation)
        }
      }
    }
  }

  func open() {
    let waiters = state.withLock { value in
      value.open = true
      let waiters = value.waiters
      value.waiters = []
      return waiters
    }
    for waiter in waiters { waiter.resume() }
  }
}
