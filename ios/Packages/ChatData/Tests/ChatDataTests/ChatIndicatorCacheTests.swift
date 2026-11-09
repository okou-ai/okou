import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import ChatData

@MainActor
final class ChatIndicatorCacheTests: XCTestCase {
  func testUnreadSnapshotReopensOfflineWithoutRestoringRunningIndicatorsOrAnotherScope() async throws {
    let offline = Mutex(false)
    let fixture = ChatHTTPFixture { request in
      if offline.withLock({ $0 }) { throw URLError(.notConnectedToInternet) }
      if request.url?.path == "/api/indicators" {
        return unreadResponse(running: true)
      }
      return try indicatorMetadata(request)
    }
    let directory = CacheTestDirectory(owner: self)
    let scope = indicatorScope(fixture)
    let sync = ChatSync(client: fixture.client, cache: directory.cache(scope: scope))
    try await sync.prefetchThreadList()
    let live = try await sync.indicators()
    XCTAssertEqual(live.threads[indicatorOtherThread], .active)

    offline.withLock { $0 = true }
    let reopened = ChatSync(client: fixture.client, cache: directory.cache(scope: scope))
    let restored = await reopened.cachedIndicators()
    let saved = try XCTUnwrap(restored)
    XCTAssertEqual(saved.indicators.threads, [indicatorThread: .unread])
    XCTAssertEqual(saved.unreadAgentIDs, [indicatorAgent])
    XCTAssertEqual(saved.unreadAt[indicatorThread], indicatorDate)
    let other = ChatSync(
      client: fixture.client,
      cache: directory.cache(
        scope: ChatCacheScope(
          apiBaseURL: fixture.baseURL, userID: "another-user", workspaceID: "workspace")))
    let foreign = await other.cachedIndicators()
    XCTAssertNil(foreign)
  }

  func testLateExtensionResponseCannotRestoreAConfirmedReadAndANewerReplyCan() async throws {
    let started = expectation(description: "Old extension unread response held")
    let gate = IndicatorResponseGate()
    let reads = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/indicators":
        let count = reads.withLock { $0 += 1; return $0 }
        if count == 2 {
          started.fulfill()
          await gate.wait()
        }
        return unreadResponse(later: count > 2)
      case "/api/chat-threads/\(indicatorThread)/mark-read":
        return ChatHTTPResponse(body: #"{"lastReadAt":"2026-11-09T00:00:00Z"}"#)
      default: return try indicatorMetadata(request)
      }
    }
    let directory = CacheTestDirectory(owner: self)
    let scope = indicatorScope(fixture)
    let app = ChatSync(client: fixture.client, cache: directory.cache(scope: scope))
    try await app.prefetchThreadList()
    _ = try await app.indicators()
    let nse = ChatSync(client: fixture.client, cache: directory.cache(scope: scope))
    let stale = Task { try await nse.indicators() }
    addTeardownBlock {
      stale.cancel()
      gate.open()
      _ = await stale.result
    }
    await fulfillment(of: [started], timeout: 2)
    let commands = ChatCommands(client: fixture.client, sync: app)
    _ = try await commands.markRead(threadID: indicatorThread)
    gate.open()
    let staleResult = try await stale.value
    XCTAssertTrue(staleResult.unreadAt.isEmpty)
    let reopened = ChatSync(client: fixture.client, cache: directory.cache(scope: scope))
    let read = await reopened.cachedIndicators()
    XCTAssertTrue(read?.unreadAt.isEmpty == true)
    XCTAssertTrue(read?.unreadAgentIDs.isEmpty == true)

    let reply = try await reopened.indicators()
    XCTAssertEqual(reply.unreadAt[indicatorThread], indicatorLaterDate)
    let savedReply = await app.cachedIndicators()
    XCTAssertEqual(savedReply?.unreadAt[indicatorThread], indicatorLaterDate)
  }

  func testLaterRequestWinsAcrossIndependentCacheConnections() async throws {
    let started = expectation(description: "First indicators request held")
    let gate = IndicatorResponseGate()
    let requests = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      guard request.url?.path == "/api/indicators" else {
        return try indicatorMetadata(request)
      }
      let first = requests.withLock { $0 += 1; return $0 == 1 }
      if first {
        started.fulfill()
        await gate.wait()
      }
      return unreadResponse(later: !first)
    }
    let directory = CacheTestDirectory(owner: self)
    let scope = indicatorScope(fixture)
    let app = ChatSync(client: fixture.client, cache: directory.cache(scope: scope))
    let nse = ChatSync(client: fixture.client, cache: directory.cache(scope: scope))
    let old = Task { try await app.indicators() }
    addTeardownBlock {
      old.cancel()
      gate.open()
      _ = await old.result
    }
    await fulfillment(of: [started], timeout: 2)
    let newer = try await nse.indicators()
    XCTAssertEqual(newer.unreadAt[indicatorThread], indicatorLaterDate)
    gate.open()
    let older = try await old.value
    XCTAssertEqual(older.unreadAt[indicatorThread], indicatorLaterDate)
    let reopened = ChatSync(client: fixture.client, cache: directory.cache(scope: scope))
    let saved = await reopened.cachedIndicators()
    XCTAssertEqual(saved?.unreadAt[indicatorThread], indicatorLaterDate)
  }

  func testBulkReadRetainsAReplyNewerThanItsStartingSnapshot() async throws {
    let started = expectation(description: "Bulk read is in flight")
    let gate = IndicatorResponseGate()
    let later = Mutex(false)
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/indicators": return unreadResponse(later: later.withLock { $0 })
      case "/api/chat-thread-unreads/mark-read":
        started.fulfill()
        await gate.wait()
        return ChatHTTPResponse(status: 204, body: "")
      default: return try indicatorMetadata(request)
      }
    }
    let directory = CacheTestDirectory(owner: self)
    let scope = indicatorScope(fixture)
    let app = ChatSync(client: fixture.client, cache: directory.cache(scope: scope))
    try await app.prefetchThreadList()
    _ = try await app.indicators()
    let commands = ChatCommands(client: fixture.client, sync: app)
    let marking = Task { try await commands.markAgentRead(agentID: indicatorAgent) }
    addTeardownBlock {
      marking.cancel()
      gate.open()
      _ = await marking.result
    }
    await fulfillment(of: [started], timeout: 2)
    later.withLock { $0 = true }
    let nse = ChatSync(client: fixture.client, cache: directory.cache(scope: scope))
    _ = try await nse.indicators()
    gate.open()
    try await marking.value
    let saved = await app.cachedIndicators()
    XCTAssertEqual(saved?.unreadAt[indicatorThread], indicatorLaterDate)
    XCTAssertEqual(saved?.unreadAgentIDs, [indicatorAgent])
  }

  func testManualUnreadRejectsAnEarlierEmptyResponse() async throws {
    let started = expectation(description: "Old read response is in flight")
    let gate = IndicatorResponseGate()
    let reads = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/indicators":
        let first = reads.withLock { $0 += 1; return $0 == 1 }
        if first {
          started.fulfill()
          await gate.wait()
          return ChatHTTPResponse(body: #"{"agents":{},"threads":{},"unreadAt":{}}"#)
        }
        return unreadResponse()
      case "/api/chat-threads/\(indicatorThread)/mark-unread":
        return ChatHTTPResponse(body: #"{"lastReadAt":null}"#)
      default: return try indicatorMetadata(request)
      }
    }
    let directory = CacheTestDirectory(owner: self)
    let scope = indicatorScope(fixture)
    let app = ChatSync(client: fixture.client, cache: directory.cache(scope: scope))
    let nse = ChatSync(client: fixture.client, cache: directory.cache(scope: scope))
    let old = Task { try await nse.indicators() }
    addTeardownBlock {
      old.cancel()
      gate.open()
      _ = await old.result
    }
    await fulfillment(of: [started], timeout: 2)
    try await ChatCommands(client: fixture.client, sync: app).markUnread(threadID: indicatorThread)
    _ = try await app.indicators()
    gate.open()
    let result = try await old.value
    XCTAssertEqual(result.threads[indicatorThread], .unread)
    let saved = await app.cachedIndicators()
    XCTAssertEqual(saved?.unreadAt[indicatorThread], indicatorDate)
  }
}

private let indicatorThread = "66000000-0000-4000-8000-000000000001"
private let indicatorOtherThread = "66000000-0000-4000-8000-000000000002"
private let indicatorAgent = "66000000-0000-4000-8000-000000000003"
private let indicatorOtherAgent = "66000000-0000-4000-8000-000000000004"
private let indicatorDate = Date(timeIntervalSince1970: 1_794_182_400)
private let indicatorLaterDate = indicatorDate.addingTimeInterval(60)

private func indicatorScope(_ fixture: ChatHTTPFixture) -> ChatCacheScope {
  ChatCacheScope(apiBaseURL: fixture.baseURL, userID: "user", workspaceID: "workspace")
}

private func unreadResponse(later: Bool = false, running: Bool = false) -> ChatHTTPResponse {
  let timestamp = later ? "2026-11-09T00:01:00Z" : "2026-11-09T00:00:00Z"
  let activeThread = running ? ",\"\(indicatorOtherThread)\":\"active\"" : ""
  let activeAgent = running ? ",\"\(indicatorOtherAgent)\":\"active\"" : ""
  return ChatHTTPResponse(
    body: """
      {"agents":{"\(indicatorAgent)":"unread"\(activeAgent)},"threads":{"\(indicatorThread)":"unread"\(activeThread)},"unreadAt":{"\(indicatorThread)":"\(timestamp)"}}
      """)
}

private func indicatorMetadata(_ request: URLRequest) throws -> ChatHTTPResponse {
  switch request.url?.path {
  case "/api/chat-threads/snapshot":
    return ChatHTTPResponse(
      body: """
        {"chatThreads":[{"id":"\(indicatorThread)","agentId":"\(indicatorAgent)","title":"Unread","createdAt":"2026-11-09T00:00:00Z","updatedAt":"2026-11-09T00:00:00Z","sortAt":"2026-11-09T00:00:00Z"}],"latestEventId":null,"latestSeqId":null}
        """)
  case "/api/chat-threads/events":
    return ChatHTTPResponse(body: #"{"events":[],"hasMore":false}"#)
  default: throw URLError(.unsupportedURL)
  }
}

private final class IndicatorResponseGate: Sendable {
  private let stream: AsyncStream<Void>
  private let continuation: AsyncStream<Void>.Continuation

  init() {
    let pair = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
    stream = pair.stream
    continuation = pair.continuation
  }

  func open() {
    continuation.yield(())
    continuation.finish()
  }

  func wait() async {
    for await _ in stream { return }
  }
}
