import ChatData
import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class UnreadPersistenceTests: XCTestCase {
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
