import ChatData
import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class ChatSyncRecoveryTests: XCTestCase {
  func testTransientListFailureKeepsSavedChatsAndRecoversWithoutAnActionError() async {
    let fixture = SyncRecoveryFixture()
    let retryStarted = expectation(description: "Read is waiting to retry")
    let retry = SyncRecoveryGate()
    let store = fixture.workspace { _ in
      retryStarted.fulfill()
      await retry.wait()
      try Task.checkCancellation()
    }
    defer {
      store.close()
      retry.open()
    }
    await store.refresh([.threadList])
    store.selectChat(SyncRecoveryFixture.threadID)
    fixture.state.value.withLock {
      $0.listFailures = 1
      $0.title = "Updated chat"
    }
    let refreshing = Task { await store.refresh([.threadList]) }
    defer { refreshing.cancel() }
    await fulfillment(of: [retryStarted], timeout: 3)
    XCTAssertEqual(store.list.threads.first?.title, "Saved chat")
    XCTAssertNotNil(store.selectedConversation)
    XCTAssertNil(store.list.syncError)
    XCTAssertNil(store.list.actionError)

    retry.open()
    await refreshing.value
    XCTAssertEqual(store.list.threads.first?.title, "Updated chat")
    XCTAssertNil(store.list.error)
  }

  func testExhaustedReadRetriesKeepChatsAvailableAndManualRetryClearsTheSyncError() async {
    let fixture = SyncRecoveryFixture()
    let store = fixture.workspace { _ in }
    defer { store.close() }
    await store.refresh([.threadList])
    store.selectChat(SyncRecoveryFixture.threadID)
    let before = fixture.state.value.withLock { state in
      state.listOffline = true
      return state.listReads
    }
    await store.refresh([.threadList])

    XCTAssertEqual(fixture.state.value.withLock { $0.listReads } - before, 3)
    XCTAssertEqual(store.list.threads.first?.title, "Saved chat")
    XCTAssertNotNil(store.selectedConversation)
    XCTAssertNotNil(store.list.syncError)
    XCTAssertNil(store.list.actionError)

    fixture.state.value.withLock {
      $0.listOffline = false
      $0.title = "Recovered chat"
    }
    await store.refresh([.threadList])
    XCTAssertEqual(store.list.threads.first?.title, "Recovered chat")
    XCTAssertNil(store.list.syncError)
  }

  func testBackgroundCancelsListIndicatorAndHistoryReadsAndForegroundCatchesUp() async throws {
    let paths: [(String, ChatInvalidation)] = [
      ("/api/chat-threads/snapshot", .threadList),
      ("/api/indicators", .readCursor),
      (
        "/api/chat-threads/\(SyncRecoveryFixture.threadID)/event-rows",
        .history(threadID: SyncRecoveryFixture.threadID)
      ),
    ]
    for (path, invalidation) in paths {
      let fixture = SyncRecoveryFixture()
      let store = fixture.workspace { _ in }
      let response = SyncRecoveryGate()
      defer {
        store.close()
        response.open()
      }
      store.setForeground(true)
      await store.refresh([.threadList])
      store.selectChat(SyncRecoveryFixture.threadID)
      let conversation = try XCTUnwrap(store.selectedConversation)
      await conversation.refresh()
      XCTAssertEqual(conversation.messages.map(\.text), ["Saved answer"])

      let started = expectation(description: "HTTP read started: " + path)
      let cancelled = expectation(description: "HTTP read cancelled: " + path)
      fixture.state.value.withLock {
        $0.blockedPath = path
        $0.beforeResponse = {
          started.fulfill()
          await withTaskCancellationHandler {
            await response.wait()
          } onCancel: {
            cancelled.fulfill()
          }
          throw URLError(.networkConnectionLost)
        }
      }
      let reading = Task { await store.refresh([invalidation]) }
      defer { reading.cancel() }
      await fulfillment(of: [started], timeout: 3)
      store.setForeground(false)
      await fulfillment(of: [cancelled], timeout: 3)
      await reading.value
      store.requestRefresh(.threadList)
      await store.refresh()
      XCTAssertEqual(conversation.messages.map(\.text), ["Saved answer"])
      XCTAssertNil(store.list.error)
      XCTAssertNil(conversation.error)

      fixture.state.value.withLock {
        $0.blockedPath = nil
        $0.beforeResponse = nil
        $0.title = "After foreground"
        $0.messages.append("New answer")
      }
      response.open()
      store.setForeground(true)
      store.requestRefresh()
      try await eventually {
        store.list.threads.first?.title == "After foreground"
          && conversation.messages.last?.text == "New answer"
      }
      XCTAssertNil(store.list.error)
      XCTAssertNil(conversation.error)
    }
  }

  func testForegroundReadOutlivesDelayedCancellationOfThePreviousRetry() async {
    let fixture = SyncRecoveryFixture()
    let retry = SyncRecoveryGate()
    let waiting = expectation(description: "Retry delay started")
    let cancelled = expectation(description: "Retry delay cancelled")
    let store = fixture.workspace { _ in
      waiting.fulfill()
      await withTaskCancellationHandler {
        await retry.wait()
      } onCancel: {
        cancelled.fulfill()
      }
      try Task.checkCancellation()
    }
    defer {
      store.close()
      retry.open()
    }
    store.setForeground(true)
    await store.refresh([.threadList])
    fixture.state.value.withLock { $0.listFailures = 1 }
    let reading = Task { await store.refresh([.threadList]) }
    defer { reading.cancel() }
    await fulfillment(of: [waiting], timeout: 3)
    store.setForeground(false)
    await fulfillment(of: [cancelled], timeout: 3)
    fixture.state.value.withLock { $0.title = "Fresh foreground read" }
    store.setForeground(true)
    await store.refresh([.threadList])
    retry.open()
    await reading.value
    XCTAssertEqual(store.list.threads.first?.title, "Fresh foreground read")
    XCTAssertNil(store.list.error)
  }

  func testLeavingOneCallerKeepsTheCoalescedHistoryRefreshAlive() async throws {
    let fixture = SyncRecoveryFixture()
    let store = fixture.workspace { _ in }
    let response = SyncRecoveryGate()
    defer {
      store.close()
      response.open()
    }
    await store.refresh([.threadList])
    store.selectChat(SyncRecoveryFixture.threadID)
    let conversation = try XCTUnwrap(store.selectedConversation)
    await conversation.refresh()
    let started = expectation(description: "View-owned history read started")
    fixture.state.value.withLock {
      $0.blockedPath = "/api/chat-threads/\(SyncRecoveryFixture.threadID)/event-rows"
      $0.beforeResponse = {
        started.fulfill()
        await response.wait()
      }
    }
    let viewRead = Task { await conversation.refresh() }
    defer { viewRead.cancel() }
    await fulfillment(of: [started], timeout: 3)
    await store.refresh([.history(threadID: SyncRecoveryFixture.threadID)])
    viewRead.cancel()
    fixture.state.value.withLock {
      $0.blockedPath = nil
      $0.beforeResponse = nil
      $0.messages.append("Answer received while leaving the view")
    }
    response.open()
    await viewRead.value
    XCTAssertEqual(conversation.messages.last?.text, "Answer received while leaving the view")
    XCTAssertNil(conversation.error)
  }

  func testActionFailureIsNotResubmittedOrErasedBySuccessfulAutomaticReads() async throws {
    let fixture = SyncRecoveryFixture()
    let store = fixture.workspace { _ in }
    defer { store.close() }
    await store.refresh([.threadList])
    let thread = try XCTUnwrap(store.list.threads.first)
    fixture.state.value.withLock { $0.renameOffline = true }
    let renamed = await store.list.rename(thread, title: "New title")
    XCTAssertFalse(renamed)
    XCTAssertEqual(fixture.state.value.withLock { $0.renameRequests }, 1)
    XCTAssertNotNil(store.list.actionError)
    XCTAssertNil(store.list.syncError)

    await store.refresh([.threadList])
    XCTAssertNotNil(store.list.actionError)
    XCTAssertNil(store.list.syncError)
    store.list.dismissError()
    XCTAssertNil(store.list.error)
  }
}

private final class SyncRecoveryFixture: Sendable {
  static let threadID = "61000000-0000-4000-8000-000000000001"
  private static let agentID = "61000000-0000-4000-8000-000000000002"
  private static let date = "2026-10-24T00:00:00Z"

  struct Values: Sendable {
    var title = "Saved chat"
    var messages = ["Saved answer"]
    var listReads = 0
    var listFailures = 0
    var listOffline = false
    var renameOffline = false
    var renameRequests = 0
    var blockedPath: String?
    var beforeResponse: (@Sendable () async throws -> Void)?
  }
  final class State: Sendable {
    let value = Mutex(Values())
  }
  let state = State()
  private let fixture: ChatHTTPFixture

  init() {
    let state = state
    fixture = ChatHTTPFixture { request in
      let path = request.url?.path ?? ""
      if let wait = state.value.withLock({ $0.blockedPath == path ? $0.beforeResponse : nil }) {
        try await wait()
      }
      switch path {
      case "/api/chat-threads/snapshot":
        let result = state.value.withLock { value in
          value.listReads += 1
          let failing = value.listOffline || value.listFailures > 0
          value.listFailures = max(0, value.listFailures - 1)
          return (value.title, failing)
        }
        if result.1 { throw URLError(.networkConnectionLost) }
        return ChatHTTPResponse(
          body: """
            {"chatThreads":[{"id":"\(Self.threadID)","agentId":"\(Self.agentID)",\
            "title":"\(result.0)","sortAt":"\(Self.date)","createdAt":"\(Self.date)",\
            "updatedAt":"\(Self.date)"}],"latestEventId":null,"latestSeqId":null}
            """)
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: #"{"events":[],"hasMore":false}"#)
      case "/api/indicators":
        return ChatHTTPResponse(body: #"{"agents":{},"threads":{},"unreadAt":{}}"#)
      case "/api/chat-threads/\(Self.threadID)/event-snapshot":
        return ChatHTTPResponse(
          status: 404,
          body: #"{"error":{"code":"CHAT_EVENT_SNAPSHOT_NOT_FOUND","message":"No snapshot"}}"#)
      case "/api/chat-threads/\(Self.threadID)/event-rows":
        let after =
          Int(
            URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
              .queryItems?.first { $0.name == "sinceSeqId" }?.value ?? "0") ?? 0
        let messages = state.value.withLock { $0.messages }
        let rows = messages.enumerated().filter { $0.offset + 1 > after }.map { index, text in
          """
          {"id":"61000000-0000-4000-8000-\(String(format: "%012d", index + 1))",\
          "chatThreadId":"\(Self.threadID)","runId":null,"revokesEventId":null,\
          "contextType":null,"contextId":null,"runEventSequenceNumber":null,"runEventId":null,\
          "seqId":\(index + 1),"createdAt":"\(Self.date)","eventType":"output.message",\
          "payload":{"content":"\(text)"}}
          """
        }
        return ChatHTTPResponse(
          body: """
            {"rows":[\(rows.joined(separator: ","))],"cursor":{\
            "lastEventId":"61000000-0000-4000-8000-\(String(format: "%012d", messages.count))",\
            "lastSeqId":\(messages.count)},"hasMore":false}
            """)
      case "/api/chat-threads/\(Self.threadID)":
        return ChatHTTPResponse(body: #"{"cancellationRecoveryPending":false}"#)
      case "/api/chat-threads/\(Self.threadID)/rename":
        let offline = state.value.withLock {
          $0.renameRequests += 1
          return $0.renameOffline
        }
        if offline { throw URLError(.networkConnectionLost) }
        return ChatHTTPResponse(body: "{}")
      default:
        throw URLError(.unsupportedURL)
      }
    }
  }

  @MainActor
  func workspace(
    sleep: @escaping @Sendable (Duration) async throws -> Void
  ) -> WorkspaceStore {
    WorkspaceStore(client: fixture.client, webURL: fixture.baseURL, readRetrySleep: sleep)
  }
}

private final class SyncRecoveryGate: Sendable {
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
        if value.open {
          continuation.resume()
        } else {
          value.waiters.append(continuation)
        }
      }
    }
  }
}
