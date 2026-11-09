import ChatData
import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class UnreadPersistenceTests: XCTestCase {
  func testUnreadArrivingBeforeANewChatSurvivesItsFailedForegroundRead() async throws {
    let hasThread = Mutex(false)
    let failing = Mutex(false)
    let threadID = ConversationHistoryFixture.threadID
    let agentID = ConversationHistoryFixture.agentID
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/chat-threads/snapshot":
        return ChatHTTPResponse(
          body: #"{"chatThreads":[],"latestEventId":null,"latestSeqId":null}"#)
      case "/api/chat-threads/events":
        let since = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
          .queryItems?.first { $0.name == "sinceSeqId" }?.value
        let event = """
          {"id":"67000000-0000-4000-8000-000000000001","seqId":1,"kind":"created","chatThreadId":"\(threadID)","agentId":"\(agentID)","title":"New answer","createdAt":"2026-11-09T00:00:00Z"}
          """
        let events = hasThread.withLock { $0 } && (since == nil || since == "0") ? event : ""
        return ChatHTTPResponse(body: "{\"events\":[\(events)],\"hasMore\":false}")
      case "/api/indicators":
        if failing.withLock({ $0 }) { throw URLError(.notConnectedToInternet) }
        return unreadPresentation(true)
      default: throw URLError(.unsupportedURL)
      }
    }
    let directory = CacheTestDirectory(owner: self)
    let sync = ChatSync(
      client: fixture.client,
      cache: directory.cache(
        scope: ChatCacheScope(
          apiBaseURL: fixture.baseURL, userID: "user", workspaceID: "workspace")))
    try await sync.prefetchThreadList()
    _ = try await sync.indicators()
    let store = WorkspaceStore(
      client: fixture.client, webURL: fixture.baseURL, sharedSync: sync,
      readRetrySleep: { _ in })
    defer { store.close() }
    await store.list.restoreCached()
    XCTAssertTrue(store.list.threads.isEmpty)

    hasThread.withLock { $0 = true }
    failing.withLock { $0 = true }
    await store.list.refresh()
    XCTAssertEqual(store.list.threads.first?.indicator, .unread)
    XCTAssertTrue(store.list.hasUnreadThreads)
    XCTAssertNil(store.list.syncError)
  }

  func testMountedAndColdListsRestoreUnreadWithoutAListEventOrForegroundNetwork() async throws {
    let unread = Mutex(false)
    let offline = Mutex(false)
    let fixture = ConversationHistoryFixture(
      count: 2,
      beforeRequest: {
        if offline.withLock({ $0 }) { throw URLError(.notConnectedToInternet) }
      },
      indicators: { _ in unreadPresentation(unread.withLock { $0 }) })
    let directory = CacheTestDirectory(owner: self)
    let scope = ChatCacheScope(
      apiBaseURL: fixture.http.baseURL, userID: "user", workspaceID: "workspace")
    let appSync = ChatSync(client: fixture.http.client, cache: directory.cache(scope: scope))
    try await appSync.prefetchThreadList()
    _ = try await appSync.indicators()
    let mounted = WorkspaceStore(
      client: fixture.http.client, webURL: fixture.http.baseURL, sharedSync: appSync)
    defer { mounted.close() }
    await mounted.list.restoreCached()
    XCTAssertEqual(mounted.list.threads.first?.indicator, nil)

    unread.withLock { $0 = true }
    let extensionSync = ChatSync(client: fixture.http.client, cache: directory.cache(scope: scope))
    _ = try await extensionSync.indicators()
    offline.withLock { $0 = true }
    await mounted.list.restoreCached()
    XCTAssertEqual(mounted.list.threads.first?.indicator, .unread)
    XCTAssertEqual(mounted.list.unreadAgentIDs, [ConversationHistoryFixture.agentID])

    let cold = WorkspaceStore(
      client: fixture.http.client, webURL: fixture.http.baseURL,
      sharedSync: ChatSync(client: fixture.http.client, cache: directory.cache(scope: scope)))
    defer { cold.close() }
    await cold.list.restoreCached()
    XCTAssertEqual(cold.list.threads.first?.indicator, .unread)
    XCTAssertTrue(cold.list.hasUnreadThreads)
    XCTAssertEqual(cold.list.unreadAgentIDs, [ConversationHistoryFixture.agentID])
  }

  func testFailedUnreadReadsKeepThePresentationWithoutAUserFacingError() async throws {
    let failing = Mutex(false)
    let fixture = ConversationHistoryFixture(
      count: 2,
      indicators: { _ in
        if failing.withLock({ $0 }) { throw URLError(.notConnectedToInternet) }
        return unreadPresentation(true)
      })
    let directory = CacheTestDirectory(owner: self)
    let sync = ChatSync(
      client: fixture.http.client,
      cache: directory.cache(
        scope: ChatCacheScope(
          apiBaseURL: fixture.http.baseURL, userID: "user", workspaceID: "workspace")))
    let store = WorkspaceStore(
      client: fixture.http.client, webURL: fixture.http.baseURL, sharedSync: sync,
      readRetrySleep: { _ in })
    defer { store.close() }
    await store.list.refresh()
    XCTAssertEqual(store.list.threads.first?.indicator, .unread)
    failing.withLock { $0 = true }
    await store.list.refresh()
    await store.list.refreshIndicators()
    XCTAssertEqual(store.list.threads.first?.indicator, .unread)
    XCTAssertEqual(store.list.unreadAgentIDs, [ConversationHistoryFixture.agentID])
    XCTAssertNil(store.list.syncError)
    XCTAssertNil(store.error)
  }
}

private func unreadPresentation(_ unread: Bool) -> ChatHTTPResponse {
  guard unread else {
    return ChatHTTPResponse(body: #"{"agents":{},"threads":{},"unreadAt":{}}"#)
  }
  return ChatHTTPResponse(
    body: """
      {"agents":{"\(ConversationHistoryFixture.agentID)":"unread"},"threads":{"\(ConversationHistoryFixture.threadID)":"unread"},"unreadAt":{"\(ConversationHistoryFixture.threadID)":"2026-11-09T00:00:00Z"}}
      """)
}
