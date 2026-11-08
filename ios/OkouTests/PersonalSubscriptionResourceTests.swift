import ChatData
import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class PersonalSubscriptionResourceTests: XCTestCase {
  func testSubscriptionReadersShareOneRequestAndReuseConfirmedAccounts() async throws {
    let gate = ModelResponseGate()
    let started = expectation(description: "Shared account request reached HTTP")
    let reads = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      XCTAssertEqual(request.url?.path, "/api/me/3rd-party-subscriptions")
      reads.withLock { $0 += 1 }
      started.fulfill()
      await gate.wait()
      return ChatHTTPResponse(body: ModelHTTPFixtures.subscriptions)
    }
    let store = PersonalSubscriptionStore(client: fixture.client, didFail: { _ in })
    let first = Task { await store.refresh() }
    addTeardownBlock { @MainActor in
      store.close()
      first.cancel()
      gate.open()
      _ = await first.value
    }
    await fulfillment(of: [started], timeout: 3)
    let groups = try store.stateStore.get(store.resources.groups)
    let second = Task { await store.refresh() }
    addTeardownBlock {
      second.cancel()
      gate.open()
      _ = await second.value
    }
    gate.open()
    let firstSucceeded = await first.value
    let secondSucceeded = await second.value
    let values = try await groups.value
    XCTAssertTrue(firstSucceeded)
    XCTAssertTrue(secondSucceeded)
    XCTAssertEqual(values.first?.accounts.first?.id, ModelHTTPFixtures.accountID)
    let reused = await store.refresh()
    XCTAssertTrue(reused)
    XCTAssertEqual(store.accounts.first?.accountEmail, "sample@example.invalid")
    XCTAssertEqual(reads.withLock { $0 }, 1)
  }

  func testConfirmedResetRetriesFailedReadbackWithoutSpendingAnotherCredit() async throws {
    let writes = Mutex(0)
    let failRead = Mutex(false)
    let fixture = ChatHTTPFixture { request in
      if request.url!.path.hasSuffix("subscription-reset") {
        writes.withLock { $0 += 1 }
        failRead.withLock { $0 = true }
        return ChatHTTPResponse(body: "{\"outcome\":\"reset\"}")
      }
      if failRead.withLock({ $0 }) {
        return ChatHTTPResponse(
          status: 503, body: "{\"error\":{\"message\":\"Usage unavailable\"}}")
      }
      return try XCTUnwrap(ModelHTTPFixtures.response(request.url!.path))
    }
    let store = PersonalSubscriptionStore(client: fixture.client, didFail: { _ in })
    defer { store.close() }
    await store.refresh()
    let account = try XCTUnwrap(store.accounts.first)
    let initial = await store.reset(account)
    XCTAssertFalse(initial)
    XCTAssertNotNil(store.error)
    failRead.withLock { $0 = false }
    let recovered = await store.reset(account)
    XCTAssertTrue(recovered)
    XCTAssertNil(store.error)
    XCTAssertEqual(store.notice, "Usage reset.")
    XCTAssertEqual(writes.withLock { $0 }, 1)
  }

  func testClosingWorkspaceCancelsOriginalSubscriptionHTTPAndRejectsItsResult() async throws {
    let began = expectation(description: "Account HTTP began")
    let cancelled = expectation(description: "Original HTTP observed cancellation")
    let gate = ModelResponseGate()
    let fixture = ChatHTTPFixture { _ in
      began.fulfill()
      return await withTaskCancellationHandler {
        await gate.wait()
        return ChatHTTPResponse(body: ModelHTTPFixtures.subscriptions)
      } onCancel: {
        cancelled.fulfill()
      }
    }
    let store = PersonalSubscriptionStore(client: fixture.client, didFail: { _ in })
    let read = Task { await store.refresh() }
    addTeardownBlock { @MainActor in
      store.close()
      read.cancel()
      gate.open()
      _ = await read.value
    }
    await fulfillment(of: [began], timeout: 3)
    store.close()
    await fulfillment(of: [cancelled], timeout: 3)
    gate.open()
    let succeeded = await read.value
    XCTAssertFalse(succeeded)
    XCTAssertTrue(store.accounts.isEmpty)
  }

  func testUsageFreshnessWindowStartsAfterSuccessfulRead() async throws {
    let clock = Mutex(Date())
    let response = Mutex(ModelHTTPFixtures.subscriptions)
    let reads = Mutex(0)
    let fixture = ChatHTTPFixture { _ in
      reads.withLock { $0 += 1 }
      return ChatHTTPResponse(body: response.withLock { $0 })
    }
    let store = PersonalSubscriptionStore(
      client: fixture.client, authNow: { clock.withLock { $0 } }, didFail: { _ in })
    defer { store.close() }
    await store.refresh()
    response.withLock {
      $0 = $0.replacingOccurrences(of: "sample@example.invalid", with: "fresh@example.invalid")
    }
    clock.withLock { $0 = $0.addingTimeInterval(59) }
    await store.refresh()
    XCTAssertEqual(store.accounts.first?.accountEmail, "sample@example.invalid")
    clock.withLock { $0 = $0.addingTimeInterval(2) }
    await store.refresh()
    XCTAssertEqual(store.accounts.first?.accountEmail, "fresh@example.invalid")
    XCTAssertEqual(reads.withLock { $0 }, 2)
  }
}
