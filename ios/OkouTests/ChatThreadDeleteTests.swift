import Synchronization
import XCTest

@testable import Okou

@MainActor
final class ChatThreadDeleteTests: XCTestCase {

  func testDeleteRemovesTheChatAtOnceAndLeavesItsOpenDetail() async throws {
    let fixture = ThreadActionsFixture()
    let store = fixture.workspace()
    defer { store.close() }
    await store.refreshNavigation()
    await store.refresh()
    store.selectChat(ThreadActionsFixture.thread)
    let gate = ThreadActionGate()
    defer { gate.open() }
    let requested = expectation(description: "Delete reached the HTTP boundary")
    fixture.state.value.withLock {
      $0.nextGate = gate
      $0.nextWriteRequested = { requested.fulfill() }
    }
    let deleting = Task { await store.deleteThread(ThreadActionsFixture.thread) }
    addTeardownBlock {
      deleting.cancel()
      gate.open()
      _ = await deleting.value
    }
    await fulfillment(of: [requested], timeout: 3)

    XCTAssertTrue(store.list.threads.isEmpty)
    XCTAssertNil(store.selectedThreadID)
    gate.open()
    let deleted = await deleting.value

    XCTAssertTrue(deleted)
    XCTAssertNil(store.threadFeedback)
    await store.refresh()
    XCTAssertTrue(store.list.threads.isEmpty)
    XCTAssertEqual(fixture.writes.map(\.action), ["delete"])
  }

  func testRejectedDeleteRestoresTheChatAndRetriesTheSameEvent() async throws {
    let fixture = ThreadActionsFixture()
    let store = fixture.workspace()
    defer { store.close() }
    await store.refreshNavigation()
    await store.refresh()
    fixture.state.value.withLock { $0.failNext["delete"] = 503 }

    let deleted = await store.deleteThread(ThreadActionsFixture.thread)

    XCTAssertFalse(deleted)
    XCTAssertEqual(store.list.threads.map(\.id), [ThreadActionsFixture.thread])
    let retry = try XCTUnwrap(store.threadFeedback)
    XCTAssertEqual(retry.actionTitle, "Retry")
    XCTAssertTrue(retry.persists)
    await retry.action()
    XCTAssertTrue(store.list.threads.isEmpty)
    XCTAssertNil(store.threadFeedback)
    XCTAssertEqual(fixture.writes.map(\.action), ["delete", "delete"])
    let eventIDs = fixture.writes.compactMap(\.eventID)
    XCTAssertEqual(eventIDs.count, 2)
    XCTAssertEqual(Set(eventIDs).count, 1)
  }
}
