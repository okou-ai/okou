import ChatData
import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class HistoryWarmingTests: XCTestCase {
  func testUnrelatedRefreshesKeepReadStateFreshWithoutStartingHistoryWarming() async throws {
    let fixture = try makeFixture(
      sleep: { _ in
        XCTFail("Non-message refreshes must not schedule history warming")
        throw CancellationError()
      },
      batch: { _ in
        XCTFail("Non-message refreshes must not request batch history")
        throw URLError(.unsupportedURL)
      })
    let workspace = fixture.workspace
    workspace.setPhase(.active)
    await workspace.list.refresh()
    XCTAssertEqual(workspace.list.threads.first?.title, "Original chat")

    fixture.state.title.withLock { $0 = "Renamed chat" }
    fixture.state.unread.withLock { $0 = true }
    await workspace.refresh([.threadList, .readCursor])
    XCTAssertEqual(workspace.list.threads.first?.title, "Renamed chat")
    XCTAssertEqual(workspace.list.threads.first?.indicator, .unread)

    await workspace.refresh([
      .initialSubscriptions, .realtimeResume, .realtimeGap, .computerAccess,
      .runModels, .modelPreference, .indicators,
      .history(threadID: warmingThreadID), .detail(threadID: warmingThreadID),
    ])
    workspace.setPhase(.background)
    workspace.setPhase(.active)
    await workspace.resumePendingRefresh()?.value
    await workspace.refresh()
    XCTAssertEqual(workspace.list.threads.first?.title, "Renamed chat")
    XCTAssertEqual(workspace.list.threads.first?.indicator, .unread)
    XCTAssertNil(workspace.list.error)
    // Join owned work so an unexpected queued warming delay cannot outlive this assertion.
    await workspace.close().value
  }

  func testStartupWarmsOnceAndARealtimeMessageStartsAnotherBatch() async throws {
    let startupBatch = expectation(description: "Startup warms unopened history")
    let messageBatch = expectation(description: "A message warms unopened history again")
    let attachRequests = expectation(description: "Both realtime subscriptions reach loopback")
    attachRequests.expectedFulfillmentCount = 2
    let mayWarm = Mutex(true)
    let cursors = Mutex<[Int]>([])
    let fixture = try makeFixture(
      onAttach: { attachRequests.fulfill() },
      sleep: { _ in
        guard mayWarm.withLock({ $0 }) else {
          XCTFail("Subscription readiness and ordinary refreshes must not repeat startup warming")
          throw CancellationError()
        }
      },
      batch: { request in
        let cursor = try warmingCursor(request)
        let round = cursors.withLock {
          $0.append(cursor)
          return $0.count
        }
        mayWarm.withLock { $0 = false }
        if round == 1 {
          startupBatch.fulfill()
        } else if round == 2 {
          messageBatch.fulfill()
        } else {
          XCTFail("An unrelated refresh started another history batch")
        }
        return emptyWarmingResponse()
      })
    try await fixture.start()
    await fulfillment(of: [startupBatch, attachRequests], timeout: 3)
    try fixture.server.attached(fixture.workspaceChannel)
    try fixture.server.attached(fixture.userChannel)
    try await waitForBusinessResult { fixture.workspace.connectionStatus == .connected }
    await fixture.workspace.resumePendingRefresh()?.value
    await fixture.workspace.refresh([.startup, .initialSubscriptions])
    XCTAssertEqual(cursors.withLock { $0 }, [0])

    fixture.state.title.withLock { $0 = "Renamed over realtime" }
    try fixture.server.notify("threadListChanged", channel: fixture.workspaceChannel)
    try await waitForBusinessResult {
      fixture.workspace.list.threads.first?.title == "Renamed over realtime"
    }
    fixture.state.unread.withLock { $0 = true }
    try fixture.server.notify("chatIndicatorsChanged", channel: fixture.workspaceChannel)
    try await waitForBusinessResult { fixture.workspace.list.threads.first?.indicator == .unread }
    fixture.state.unread.withLock { $0 = false }
    try fixture.server.notify("chatThreadReadCursorUpdated", channel: fixture.workspaceChannel)
    try await waitForBusinessResult { fixture.workspace.list.threads.first?.indicator == nil }
    await fixture.workspace.resumePendingRefresh()?.value
    XCTAssertEqual(cursors.withLock { $0 }, [0])

    mayWarm.withLock { $0 = true }
    try fixture.server.notify(
      "chatThreadMessageCreated:\(warmingThreadID)", channel: fixture.workspaceChannel)
    await fulfillment(of: [messageBatch], timeout: 3)
    XCTAssertEqual(cursors.withLock { $0 }, [0, 0])
    XCTAssertNil(fixture.workspace.selectedConversation)
    XCTAssertNil(fixture.workspace.list.error)
    await fixture.workspace.close().value
  }

  func testForegroundResumesAnInterruptedStartupWarmWithoutANewMessage() async throws {
    let warmingPaused = expectation(description: "Startup warming is waiting to coalesce")
    let warmingCancelled = expectation(description: "Background interrupts the pending warm")
    let resumedBatch = expectation(description: "Foreground completes the interrupted warm")
    let firstDelay = Mutex(true)
    let releaseDelay = ModelResponseGate()
    addTeardownBlock { releaseDelay.open() }
    let fixture = try makeFixture(
      sleep: { _ in
        let first = firstDelay.withLock {
          let result = $0
          $0 = false
          return result
        }
        if first {
          warmingPaused.fulfill()
          await withTaskCancellationHandler {
            await releaseDelay.wait()
          } onCancel: {
            warmingCancelled.fulfill()
          }
          try Task.checkCancellation()
        }
      },
      batch: { request in
        XCTAssertEqual(try warmingCursor(request), 0)
        resumedBatch.fulfill()
        return emptyWarmingResponse()
      })
    fixture.workspace.setPhase(.active)
    await fixture.workspace.refresh([.startup])
    await fulfillment(of: [warmingPaused], timeout: 3)
    fixture.workspace.setPhase(.background)
    await fulfillment(of: [warmingCancelled], timeout: 3)
    fixture.workspace.setPhase(.active)
    await fixture.workspace.resumePendingRefresh()?.value
    await fulfillment(of: [resumedBatch], timeout: 3)
    releaseDelay.open()
    XCTAssertNil(fixture.workspace.list.error)
  }

  private func makeFixture(
    onAttach: @escaping @Sendable () -> Void = {},
    sleep: @escaping @Sendable (Duration) async throws -> Void,
    batch: @escaping ChatHTTPFixture.Handler
  ) throws -> HistoryWarmingFixture {
    let directory = CacheTestDirectory(owner: self)
    let fixture = try HistoryWarmingFixture(
      directory: directory, onAttach: onAttach, sleep: sleep, batch: batch)
    addTeardownBlock { @MainActor in await fixture.close() }
    return fixture
  }
}

@MainActor
private final class HistoryWarmingFixture {
  private let realtime: LoopbackRealtimeFixture
  var server: RealtimeHTTPFixture { realtime.server }
  let http: ChatHTTPFixture
  let cache: ChatCache
  let state = HistoryWarmingState()
  private let userID = "warming-user-\(UUID().uuidString)"
  private let workspaceID = "warming-workspace-\(UUID().uuidString)"
  private let sleep: @Sendable (Duration) async throws -> Void
  var workspaceChannel: String { "user-org:\(userID):\(workspaceID)" }
  var userChannel: String { "user:\(userID)" }

  lazy var workspace = WorkspaceStore(
    client: http.client, webURL: http.baseURL, cache: cache, historyWarmingSleep: sleep,
    createRealtime: realtime.factory)

  init(
    directory: CacheTestDirectory, onAttach: @escaping @Sendable () -> Void,
    sleep: @escaping @Sendable (Duration) async throws -> Void,
    batch: @escaping ChatHTTPFixture.Handler
  ) throws {
    self.sleep = sleep
    let state = state
    let token = try JSONSerialization.data(withJSONObject: [
      "keyName": "fixture.key", "timestamp": Int64(Date().timeIntervalSince1970 * 1000),
      "ttl": 3_600_000, "nonce": "fixture-nonce", "mac": "ZmFrZQ==",
      "clientId": userID, "capability": "{\"*\":[\"subscribe\"]}",
    ])
    http = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/agents": return ChatHTTPResponse(body: "[]")
      case "/api/realtime/token":
        return ChatHTTPResponse(body: String(decoding: token, as: UTF8.self))
      case "/api/chat-threads/snapshot":
        let title = state.title.withLock { $0 }
        let sequence = title == "Original chat" ? 1 : 2
        return ChatHTTPResponse(
          body: """
            {"chatThreads":[{"id":"\(warmingThreadID)","agentId":"\(warmingAgentID)",\
            "title":"\(title)","createdAt":"2026-10-20T00:00:00Z",\
            "updatedAt":"2026-10-20T00:00:00Z","sortAt":"2026-10-20T00:00:00Z"}],\
            "latestEventId":"\(warmingListEventID(sequence))","latestSeqId":\(sequence)}
            """)
      case "/api/chat-threads/events":
        let after =
          URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
          .queryItems?.first { $0.name == "sinceSeqId" }?.value.flatMap(Int.init) ?? 0
        let title = state.title.withLock { $0 }
        var events: [String] = []
        if after < 1 {
          events.append(warmingListEvent(1, kind: "created", title: "Original chat"))
        }
        if after < 2, title != "Original chat" {
          events.append(warmingListEvent(2, kind: "renamed", title: title))
        }
        return ChatHTTPResponse(
          body: "{\"events\":[\(events.joined(separator: ","))],\"hasMore\":false}")
      case "/api/indicators":
        let unread = state.unread.withLock { $0 }
        let agents = unread ? "\"\(warmingAgentID)\":\"unread\"" : ""
        let threads = unread ? "\"\(warmingThreadID)\":\"unread\"" : ""
        let unreadAt = unread ? "\"\(warmingThreadID)\":\"2026-10-20T00:00:00Z\"" : ""
        return ChatHTTPResponse(
          body: "{\"agents\":{\(agents)},\"unreadAt\":{\(unreadAt)},\"threads\":{\(threads)}}")
      case "/api/chat/events/catch-up": return try await batch(request)
      default: throw URLError(.unsupportedURL)
      }
    }
    cache = directory.cache(
      scope: ChatCacheScope(apiBaseURL: http.baseURL, userID: userID, workspaceID: workspaceID))
    let attaches = Mutex(0)
    realtime = try LoopbackRealtimeFixture(clientID: userID) { action, channel in
      guard action == 10, !channel.hasPrefix("user-org-foreground:") else { return }
      let count = attaches.withLock {
        $0 += 1
        return $0
      }
      if count <= 2 { onAttach() }
    }
  }

  func start() async throws {
    try await realtime.start()
    workspace.setPhase(.active)
    await workspace.start(userID: userID, workspaceID: workspaceID)
  }

  func close() async {
    await workspace.close().value
    realtime.stop()
  }
}

private final class HistoryWarmingState: Sendable {
  let title = Mutex("Original chat")
  let unread = Mutex(false)
}

private func warmingCursor(_ request: URLRequest) throws -> Int {
  let pairs = try XCTUnwrap(
    JSONSerialization.jsonObject(with: chatRequestBody(request)) as? [[Any]])
  XCTAssertEqual(pairs.count, 1)
  let pair = try XCTUnwrap(pairs.first)
  XCTAssertEqual(pair.first as? String, warmingThreadID)
  return try XCTUnwrap(pair.last as? Int)
}

private func emptyWarmingResponse() -> ChatHTTPResponse {
  ChatHTTPResponse(body: "{\"events\":{\"\(warmingThreadID)\":[]},\"notFoundThreads\":[]}")
}

private func warmingListEvent(_ sequence: Int, kind: String, title: String) -> String {
  """
  {"id":"\(warmingListEventID(sequence))","seqId":\(sequence),"kind":"\(kind)",\
  "chatThreadId":"\(warmingThreadID)","agentId":"\(warmingAgentID)",\
  "title":"\(title)","createdAt":"2026-10-20T00:00:00Z"}
  """
}

private func warmingListEventID(_ sequence: Int) -> String {
  String(format: "73000000-0000-4000-8000-%012d", sequence + 10)
}

private let warmingThreadID = "73000000-0000-4000-8000-000000000001"
private let warmingAgentID = "73000000-0000-4000-8000-000000000002"
