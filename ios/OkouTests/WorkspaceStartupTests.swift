import ChatData
import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class WorkspaceStartupTests: XCTestCase {
  func testCancelledStartupDoesNotCreateRealtimeOrReadNavigation() async {
    let requests = Mutex<[String]>([])
    let fixture = ChatHTTPFixture { request in
      requests.withLock { $0.append(request.url?.path ?? "") }
      throw URLError(.unsupportedURL)
    }
    let store = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
    defer { store.close() }
    let startup = Task { await store.start(userID: "user", workspaceID: "workspace") }
    startup.cancel()
    await startup.value

    XCTAssertTrue(requests.withLock { $0.isEmpty })
    XCTAssertTrue(store.list.threads.isEmpty)
  }

  func testStartupLoadsChatsAndRealtimeAndPreservesTheDraft()
    async throws
  {
    let realtime = expectation(description: "Realtime starts independently of navigation")
    let requestedRealtime = Mutex(false)
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/chat-threads/snapshot": return threadSnapshot(title: "Existing chat")
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: #"{"events":[],"hasMore":false}"#)
      case "/api/indicators":
        return ChatHTTPResponse(body: #"{"unreadAt":{},"threads":{}}"#)
      case "/api/realtime/token":
        if requestedRealtime.withLock({ requested in
          guard !requested else { return false }
          requested = true
          return true
        }) {
          realtime.fulfill()
        }
        return ChatHTTPResponse(status: 403, body: #"{"error":{"message":"Fixture"}}"#)
      default: throw URLError(.unsupportedURL)
      }
    }
    let store = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
    defer { store.close() }
    store.newChatDraft = "Input entered before navigation finishes"
    let startup = Task { await store.start(userID: "user", workspaceID: "workspace") }
    addTeardownBlock { @MainActor in
      store.close()
      startup.cancel()
      await startup.value
    }
    await fulfillment(of: [realtime], timeout: 3)
    try await waitForBusinessResult { store.list.threads.first?.title == "Existing chat" }
    await startup.value
    XCTAssertEqual(store.newChatDraft, "Input entered before navigation finishes")
    XCTAssertNil(store.selectedThreadID)
  }

  func testStartupRestoresCachedProjectsBeforeNetworkAndPreservesArchiveVisibility() async throws {
    let cacheDirectory = CacheTestDirectory(owner: self)
    let archivedID = "40000000-0000-4000-8000-000000000004"
    let projectID = "30000000-0000-4000-8000-000000000071"
    let snapshot = Self.cachedSnapshot(archivedID: archivedID, projectID: projectID)
    let catchUpStarted = expectation(
      description: "Cached chats are shown before network catch-up")
    let releaseCatchUp = HTTPResponseGate()
    defer { releaseCatchUp.open() }
    let holdCatchUp = Mutex(false)
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/chat-threads/snapshot": return snapshot
      case "/api/projects/snapshot":
        return ChatHTTPResponse(
          body: """
            {"latestEventId":null,"latestSeqId":0,"projects":[{
            "id":"\(projectID)","name":"Cached Project",\
            "createdAt":"\(storeDate)","updatedAt":"\(storeDate)"}]}
            """)
      case "/api/projects/events":
        return ChatHTTPResponse(body: #"{"events":[],"hasMore":false}"#)
      case "/api/chat-threads/events":
        if holdCatchUp.withLock({ $0 }) {
          catchUpStarted.fulfill()
          await releaseCatchUp.wait()
        }
        return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
      case "/api/indicators":
        return ChatHTTPResponse(body: "{\"unreadAt\":{},\"threads\":{}}")
      case "/api/realtime/token":
        return ChatHTTPResponse(
          status: 403, body: "{\"error\":{\"message\":\"No live updates\"}}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let scope = ChatCacheScope(
      apiBaseURL: fixture.baseURL, userID: "user", workspaceID: "workspace")
    let cache = cacheDirectory.cache(scope: scope)
    let previous = WorkspaceStore(
      client: fixture.client, webURL: fixture.baseURL, cache: cache,
      projectDisclosure: ProjectDisclosureStorage(scope: scope, directory: cacheDirectory.url))
    await previous.prepareWorkspaceComposer()
    await previous.list.refresh()
    await previous.projects.activate()
    await previous.projects.expand(projectID)?.value
    XCTAssertNil(previous.list.error)
    await previous.close().value
    await cache.close()

    holdCatchUp.withLock { $0 = true }
    let store = WorkspaceStore(
      client: fixture.client, webURL: fixture.baseURL, cache: cacheDirectory.cache(scope: scope),
      projectDisclosure: ProjectDisclosureStorage(scope: scope, directory: cacheDirectory.url))
    defer { store.close() }
    store.startNewChat()
    let startup = Task { await store.start(userID: "user", workspaceID: "workspace") }
    addTeardownBlock { @MainActor in
      let closing = store.close()
      startup.cancel()
      releaseCatchUp.open()
      await startup.value
      await closing.value
    }
    await fulfillment(of: [catchUpStarted], timeout: 2)
    try assertCachedProjectSidebar(store, projectID: projectID)
    let expected = ["Recent cached chat"]
    XCTAssertEqual(
      store.list.threads(archived: false).map(\.title), expected)
    releaseCatchUp.open()
    await startup.value
    XCTAssertEqual(
      store.list.threads(archived: false).map(\.title), expected)
    XCTAssertEqual(
      store.list.threads(archived: true).map(\.title),
      ["Archived cached chat"])
    XCTAssertNil(store.list.error)
  }

  private static func cachedSnapshot(archivedID: String, projectID: String) -> ChatHTTPResponse {
    ChatHTTPResponse(
      body: """
        {"chatThreads":[
          {"id":"\(storeThreadID)","projectId":"\(projectID)",\
        "title":"Recent cached chat",\
        "sortAt":"\(storeDate)","createdAt":"\(storeDate)","updatedAt":"\(storeDate)","archived":false},
          {"id":"\(archivedID)","title":"Archived cached chat",\
        "sortAt":"\(storeDate)","createdAt":"\(storeDate)","updatedAt":"\(storeDate)","archived":true}
        ],"latestEventId":null,"latestSeqId":null}
        """)
  }

  private func assertCachedProjectSidebar(_ store: WorkspaceStore, projectID: String) throws {
    let cached = try store.sidebar.stateStore.get(store.sidebar.presentation)
    XCTAssertEqual(cached.projects.map(\.project.name), ["Cached Project"])
    XCTAssertEqual(cached.projects.first?.section.rows.map(\.title), ["Recent cached chat"])
    XCTAssertTrue(store.projects.isExpanded(projectID))
    XCTAssertTrue(cached.chats.isEmpty)
    XCTAssertEqual(
      store.list.threads(archived: false).map(\.title),
      ["Recent cached chat"])
  }

  func testRepeatedListRestoreFindsASeparateWritersNewerCommittedCacheWhileOffline() async throws {
    let directory = CacheTestDirectory(owner: self)
    let updated = Mutex(false)
    let offline = Mutex(false)
    let fixture = ChatHTTPFixture { request in
      if offline.withLock({ $0 }) { throw URLError(.notConnectedToInternet) }
      switch request.url?.path {
      case "/api/chat-threads/snapshot": return threadSnapshot(title: "Cached chat")
      case "/api/chat-threads/events":
        let since = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
          .queryItems?.first { $0.name == "sinceSeqId" }?.value
        let events =
          updated.withLock { $0 } && since == nil
          ? """
          {"id":"\(storeEventID(1))","seqId":1,"kind":"renamed",\
          "chatThreadId":"\(storeThreadID)",\
          "title":"Prefetched title","createdAt":"\(storeDate)"}
          """ : ""
        return ChatHTTPResponse(body: "{\"events\":[\(events)],\"hasMore\":false}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let scope = ChatCacheScope(
      apiBaseURL: fixture.baseURL, userID: "cache-reader", workspaceID: "cache-workspace")
    let writer = ChatSync(client: fixture.client, cache: directory.cache(scope: scope))
    try await writer.prefetchThreadList()
    let reader = WorkspaceStore(
      client: fixture.client, webURL: fixture.baseURL, cache: directory.cache(scope: scope))
    defer { reader.close() }
    await reader.list.restoreCached()
    await reader.list.restoreCached()
    XCTAssertEqual(reader.list.threads.map(\.title), ["Cached chat"])

    updated.withLock { $0 = true }
    try await writer.prefetchThreadList()
    offline.withLock { $0 = true }
    await reader.list.restoreCached()
    XCTAssertEqual(reader.list.threads.map(\.title), ["Prefetched title"])
    await reader.list.restoreCached()
    XCTAssertEqual(reader.list.threads.map(\.title), ["Prefetched title"])
  }

  func testClosingOrCancellingStartupKeepsCachedChatsAndStopsCatchUp() async throws {
    for cancelStartup in [false, true] {
      let cacheDirectory = CacheTestDirectory(owner: self)
      let catchUpStarted = expectation(
        description: "Thread catch-up starts after cached chats")
      let cachePrimed = Mutex(false)
      let releaseCatchUp = HTTPResponseGate()
      defer { releaseCatchUp.open() }
      let fixture = ChatHTTPFixture { request in
        switch request.url?.path {
        case "/api/chat-threads/snapshot": return threadSnapshot(title: "Cached chat")
        case "/api/chat-threads/events":
          if cachePrimed.withLock({ $0 }) {
            catchUpStarted.fulfill()
            await releaseCatchUp.wait()
          }
          return ChatHTTPResponse(body: #"{"events":[],"hasMore":false}"#)
        case "/api/indicators":
          return ChatHTTPResponse(body: #"{"unreadAt":{},"threads":{}}"#)
        case "/api/realtime/token":
          return ChatHTTPResponse(
            status: 403, body: "{\"error\":{\"message\":\"No live updates\"}}")
        default: throw URLError(.unsupportedURL)
        }
      }
      let cache = cacheDirectory.cache(
        scope: ChatCacheScope(
          apiBaseURL: fixture.baseURL, userID: "user", workspaceID: "workspace"))
      try await ChatSync(client: fixture.client, cache: cache).prefetchThreadList()
      cachePrimed.withLock { $0 = true }
      let store = WorkspaceStore(
        client: fixture.client, webURL: fixture.baseURL, cache: cache)
      defer { store.close() }
      let startup = Task { await store.start(userID: "user", workspaceID: "workspace") }
      await fulfillment(of: [catchUpStarted], timeout: 2)
      XCTAssertEqual(store.list.threads.map(\.title), ["Cached chat"])

      if cancelStartup {
        startup.cancel()
      } else {
        store.close()
      }
      releaseCatchUp.open()
      await startup.value

      XCTAssertEqual(store.list.threads.map(\.title), ["Cached chat"])
    }
  }

  func testClosedStoreIgnoresDelayedHistoryAndDoesNotAffectFreshStore() async throws {
    let oldReadStarted = expectation(description: "Old store is waiting for history")
    let releaseOldResponse = HTTPResponseGate()
    defer { releaseOldResponse.open() }
    let oldMarkReadRequests = Mutex<[String]>([])
    let oldFixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/chat-threads/snapshot": return threadSnapshot(title: "Old workspace chat")
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
      case "/api/indicators":
        return ChatHTTPResponse(
          body: "{\"unreadAt\":{},\"threads\":{\"\(storeThreadID)\":\"unread\"}}")
      case "/api/chat-threads/\(storeThreadID)/event-snapshot":
        return ChatHTTPResponse(
          status: 404,
          body:
            "{\"error\":{\"code\":\"CHAT_EVENT_SNAPSHOT_NOT_FOUND\",\"message\":\"No snapshot\"}}")
      case "/api/chat-threads/\(storeThreadID)/event-rows":
        let cursor = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
          .queryItems?.first { $0.name == "sinceSeqId" }?.value
        if cursor == "2" { return historyPage(rows: [], lastSequence: 2) }
        oldReadStarted.fulfill()
        await releaseOldResponse.wait()
        return historyPage(
          rows: [
            historyEvent(
              sequence: 1, type: "output.message", payload: "{\"content\":\"Old workspace answer\"}"
            ),
            historyEvent(sequence: 2, type: "run.completed")
          ], lastSequence: 2)
      case "/api/chat-threads/\(storeThreadID)":
        return ChatHTTPResponse(body: "{\"cancellationRecoveryPending\":false}")
      case "/api/chat-threads/\(storeThreadID)/mark-read":
        oldMarkReadRequests.withLock { $0.append(request.httpMethod ?? "") }
        return ChatHTTPResponse(body: "{\"lastReadAt\":\"2026-09-17T12:00:00Z\"}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let oldStore = WorkspaceStore(client: oldFixture.client, webURL: oldFixture.baseURL)
    defer { oldStore.close() }
    await oldStore.refresh()
    oldStore.setPhase(.active)
    oldStore.selectedThreadID = storeThreadID
    let oldConversation = try XCTUnwrap(oldStore.conversation(for: storeThreadID))
    let oldRead = Task { await oldConversation.refresh() }
    await fulfillment(of: [oldReadStarted], timeout: 2)
    oldStore.close()

    let freshFixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/chat-threads/snapshot": return threadSnapshot(title: "Fresh workspace chat")
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
      case "/api/indicators":
        return ChatHTTPResponse(body: "{\"unreadAt\":{},\"threads\":{}}")
      case "/api/chat-threads/\(storeThreadID)/event-snapshot":
        return ChatHTTPResponse(
          status: 404,
          body:
            "{\"error\":{\"code\":\"CHAT_EVENT_SNAPSHOT_NOT_FOUND\",\"message\":\"No snapshot\"}}")
      case "/api/chat-threads/\(storeThreadID)/event-rows":
        let cursor = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
          .queryItems?.first { $0.name == "sinceSeqId" }?.value
        if cursor == "2" { return historyPage(rows: [], lastSequence: 2) }
        return historyPage(
          rows: [
            historyEvent(
              sequence: 1, type: "output.message",
              payload: "{\"content\":\"Fresh workspace answer\"}"),
            historyEvent(sequence: 2, type: "run.completed")
          ], lastSequence: 2)
      case "/api/chat-threads/\(storeThreadID)":
        return ChatHTTPResponse(body: "{\"cancellationRecoveryPending\":false}")
      case "/api/chat-threads/\(storeThreadID)/mark-read":
        return ChatHTTPResponse(body: "{\"lastReadAt\":\"2026-09-17T10:00:00Z\"}")
      default: throw URLError(.unsupportedURL)
      }
    }
    // The same thread identity deliberately verifies that history caches belong to each store.
    let freshStore = WorkspaceStore(client: freshFixture.client, webURL: freshFixture.baseURL)
    defer { freshStore.close() }
    freshStore.setPhase(.active)
    freshStore.selectedThreadID = storeThreadID
    await freshStore.refresh()
    XCTAssertEqual(
      (freshStore.conversation(for: storeThreadID)?.messages ?? []).map(\.text),
      ["Fresh workspace answer"])

    releaseOldResponse.open()
    await oldRead.value

    XCTAssertTrue(oldConversation.messages.isEmpty)
    XCTAssertTrue(oldMarkReadRequests.withLock { $0.isEmpty })
    XCTAssertEqual(
      (freshStore.conversation(for: storeThreadID)?.messages ?? []).map(\.text),
      ["Fresh workspace answer"])
    XCTAssertEqual(freshStore.list.threads.map(\.title), ["Fresh workspace chat"])
    XCTAssertNil(freshStore.error)
    XCTAssertNil(freshStore.conversation(for: storeThreadID)?.error)
  }
}
