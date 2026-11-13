import ChatData
import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class ThreadListResourceTests: XCTestCase {
  func testConcurrentListReadersShareHTTPWhenOneObserverIsCancelled() async throws {
    let gate = ModelResponseGate()
    let began = expectation(description: "The original list HTTP request started")
    let fixture = ThreadListReadFixture { _ in
      began.fulfill()
      await gate.wait()
    }
    let workspace = fixture.workspace()
    let refreshing = Task.immediate { await workspace.list.refresh() }
    addTeardownBlock { @MainActor in
      let closing = workspace.close()
      gate.open()
      refreshing.cancel()
      _ = await refreshing.value
      await closing.value
    }
    await fulfillment(of: [began], timeout: 3)
    let shared = try workspace.list.stateStore.get(workspace.list.listValue)
    let observer = Task.immediate { try await shared.value }
    addTeardownBlock {
      observer.cancel()
      gate.open()
      _ = await observer.result
    }
    observer.cancel()
    gate.open()
    let succeeded = await refreshing.value
    try await shared.value
    XCTAssertTrue(succeeded)
    XCTAssertEqual(workspace.list.threads.first?.title, "Original chat")
    XCTAssertEqual(fixture.state.value.withLock { $0.reads }, 1)
  }

  func testAnOverlappingInvalidationAwaitsOneFreshFollowUpOnTheSharedTask() async throws {
    let gate = ModelResponseGate()
    let began = expectation(description: "The first snapshot captured the old title")
    let fixture = ThreadListReadFixture { count in
      if count == 1 {
        began.fulfill()
        await gate.wait()
      }
    }
    let workspace = fixture.workspace()
    let first = Task.immediate { await workspace.list.refresh() }
    addTeardownBlock { @MainActor in
      let closing = workspace.close()
      gate.open()
      first.cancel()
      _ = await first.value
      await closing.value
    }
    await fulfillment(of: [began], timeout: 3)
    fixture.state.value.withLock { $0.title = "Fresh chat" }
    let followUp = Task.immediate { await workspace.list.refresh(waitForCurrent: true) }
    addTeardownBlock {
      followUp.cancel()
      gate.open()
      _ = await followUp.value
    }
    let shared = try workspace.list.stateStore.get(workspace.list.listValue)
    gate.open()
    let firstSucceeded = await first.value
    let followUpSucceeded = await followUp.value
    try await shared.value
    XCTAssertTrue(firstSucceeded)
    XCTAssertTrue(followUpSucceeded)
    XCTAssertEqual(workspace.list.threads.first?.title, "Fresh chat")
    XCTAssertEqual(fixture.state.value.withLock { $0.reads }, 2)
  }

  func testFailedListReadRemainsSharedUntilExplicitRefreshSucceeds() async throws {
    let fixture = ThreadListReadFixture()
    let workspace = fixture.workspace()
    addTeardownBlock { @MainActor in await workspace.close().value }
    fixture.state.value.withLock { $0.status = 403 }
    let failed = await workspace.list.refresh()
    XCTAssertFalse(failed)
    do {
      try await workspace.list.stateStore.get(workspace.list.listValue).value
      XCTFail("Another observer must see the original HTTP failure")
    } catch {
      XCTAssertEqual((error as? APIClientError)?.statusCode, 403)
    }
    XCTAssertEqual(fixture.state.value.withLock { $0.reads }, 1)
    fixture.state.value.withLock {
      $0.status = 200
      $0.title = "Recovered chat"
    }
    let recovered = await workspace.list.refresh()
    try await workspace.list.stateStore.get(workspace.list.listValue).value
    XCTAssertTrue(recovered)
    XCTAssertEqual(workspace.list.threads.first?.title, "Recovered chat")
    XCTAssertEqual(fixture.state.value.withLock { $0.reads }, 2)
  }

  func testRetiringTheWorkspaceCancelsOriginalHTTPAndFencesItsReplacement() async throws {
    let gate = ModelResponseGate()
    let began = expectation(description: "The retiring workspace has pending HTTP")
    let cancelled = expectation(description: "The original list HTTP request was cancelled")
    let fixture = ThreadListReadFixture { count in
      if count == 1 {
        began.fulfill()
        await withTaskCancellationHandler {
          await gate.wait()
        } onCancel: {
          cancelled.fulfill()
        }
      }
    }
    let previous = fixture.workspace()
    let first = Task.immediate { await previous.list.refresh() }
    addTeardownBlock { @MainActor in
      let closing = previous.close()
      gate.open()
      first.cancel()
      _ = await first.value
      await closing.value
    }
    await fulfillment(of: [began], timeout: 3)
    let original = try previous.list.stateStore.get(previous.list.listValue)
    let closing = previous.close()
    await fulfillment(of: [cancelled], timeout: 3)
    fixture.state.value.withLock { $0.title = "Replacement chat" }
    let replacement = fixture.workspace()
    addTeardownBlock { @MainActor in await replacement.close().value }
    let refreshed = await replacement.list.refresh()
    XCTAssertTrue(refreshed)
    gate.open()
    _ = await first.value
    await closing.value
    guard case .failure = await original.result else {
      return XCTFail("Retired HTTP must not publish a successful resource result")
    }
    XCTAssertThrowsError(try previous.list.stateStore.get(previous.list.listValue))
    XCTAssertEqual(replacement.list.threads.first?.title, "Replacement chat")
    XCTAssertEqual(fixture.state.value.withLock { $0.reads }, 2)
  }
}

private final class ThreadListReadFixture: Sendable {
  struct Values: Sendable {
    var title = "Original chat"
    var status = 200
    var reads = 0
  }
  final class State: Sendable {
    let value = Mutex(Values())
  }
  let state = State()
  private let http: ChatHTTPFixture

  init(beforeSnapshot: @escaping @Sendable (Int) async -> Void = { _ in }) {
    let state = state
    http = ChatHTTPFixture { request in
      switch request.url!.path {
      case "/api/chat-threads/snapshot":
        let response = state.value.withLock { value in
          value.reads += 1
          return (value.title, value.status, value.reads)
        }
        await beforeSnapshot(response.2)
        if response.1 != 200 {
          return ChatHTTPResponse(
            status: response.1, body: #"{"error":{"message":"List unavailable"}}"#)
        }
        return ChatHTTPResponse(
          body: """
            {"chatThreads":[{"id":"98000000-0000-4000-8000-000000000001",\
            "agentId":"98000000-0000-4000-8000-000000000002","title":"\(response.0)",\
            "sortAt":"2026-11-13T00:00:00Z","createdAt":"2026-11-13T00:00:00Z",\
            "updatedAt":"2026-11-13T00:00:00Z"}],"latestEventId":null,"latestSeqId":null}
            """)
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: #"{"events":[],"hasMore":false}"#)
      case "/api/indicators":
        return ChatHTTPResponse(body: #"{"agents":{},"threads":{},"unreadAt":{}}"#)
      default: throw URLError(.unsupportedURL)
      }
    }
  }

  @MainActor
  func workspace() -> WorkspaceStore {
    WorkspaceStore(client: http.client, webURL: http.baseURL, readRetrySleep: { _ in })
  }
}
