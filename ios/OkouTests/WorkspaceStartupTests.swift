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

  func testStartupLoadsChatsAndRealtimeDuringSlowNavigationAndPreservesTheDraft()
    async throws
  {
    let gate = HTTPResponseGate()
    defer { gate.open() }
    let navigation = expectation(description: "Agent response is pending")
    let realtime = expectation(description: "Realtime starts independently of navigation")
    let requestedRealtime = Mutex(false)
    let defaultAgent = "40000000-0000-4000-8000-000000000008"
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/agents":
        navigation.fulfill()
        await gate.wait()
        return ChatHTTPResponse(
          body: """
            [{"agentId":"\(defaultAgent)","isDefaultAgent":true,"displayName":"Default assistant"},
            {"agentId":"\(storeAgentID)","isDefaultAgent":false,"displayName":"Other assistant"}]
            """)

      case "/api/chat-threads/snapshot": return threadSnapshot(title: "Other agent's chat")
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: #"{"events":[],"hasMore":false}"#)
      case "/api/indicators":
        return ChatHTTPResponse(body: #"{"agents":{},"unreadAt":{},"threads":{}}"#)
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
      gate.open()
      await startup.value
    }
    await fulfillment(of: [navigation, realtime], timeout: 3)
    try await waitForBusinessResult { store.list.threads.first?.title == "Other agent's chat" }
    XCTAssertNil(store.selectedAgentID)
    gate.open()
    await startup.value
    XCTAssertEqual(store.selectedAgentID, defaultAgent)
    XCTAssertEqual(store.newChatDraft, "Input entered before navigation finishes")
    XCTAssertNil(store.selectedThreadID)
  }

  func testStartupRestoresCachedProjectsBeforeNetworkAndPreservesArchiveVisibility() async throws {
    let cacheDirectory = CacheTestDirectory(owner: self)
    let archivedID = "40000000-0000-4000-8000-000000000004"
    let projectID = "30000000-0000-4000-8000-000000000071"
    let snapshot = ChatHTTPResponse(
      body: """
        {"chatThreads":[
          {"id":"\(storeThreadID)","agentId":"\(storeAgentID)","projectId":"\(projectID)",\
        "title":"Recent cached chat",\
        "sortAt":"\(storeDate)","createdAt":"\(storeDate)","updatedAt":"\(storeDate)","archived":false},
          {"id":"\(archivedID)","agentId":"\(storeAgentID)","title":"Archived cached chat",\
        "sortAt":"\(storeDate)","createdAt":"\(storeDate)","updatedAt":"\(storeDate)","archived":true}
        ],"latestEventId":null,"latestSeqId":null}
        """)
    let navigationStarted = expectation(description: "Navigation is being loaded")
    let holdNavigation = Mutex(false)
    let releaseNavigation = HTTPResponseGate()
    defer { releaseNavigation.open() }
    let catchUpStarted = expectation(
      description: "Cached chats are shown before network catch-up")
    let releaseCatchUp = HTTPResponseGate()
    defer { releaseCatchUp.open() }
    let holdCatchUp = Mutex(false)
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/agents":
        if holdNavigation.withLock({ $0 }) {
          navigationStarted.fulfill()
          await releaseNavigation.wait()
        }
        return ChatHTTPResponse(
          body: """
            [{"agentId":"\(storeAgentID)","isDefaultAgent":true,"displayName":"Okou"}]
            """)
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
        return ChatHTTPResponse(body: "{\"agents\":{},\"unreadAt\":{},\"threads\":{}}")
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
    await previous.refreshNavigation()
    await previous.list.refresh()
    await previous.projects.activate()
    await previous.projects.expand(projectID)?.value
    XCTAssertNil(previous.list.error)
    await previous.close().value

    holdNavigation.withLock { $0 = true }
    holdCatchUp.withLock { $0 = true }
    let store = WorkspaceStore(
      client: fixture.client, webURL: fixture.baseURL, cache: cache,
      projectDisclosure: ProjectDisclosureStorage(scope: scope, directory: cacheDirectory.url))
    defer { store.close() }
    store.startNewChat()
    let startup = Task { await store.start(userID: "user", workspaceID: "workspace") }
    addTeardownBlock { @MainActor in
      let closing = store.close()
      startup.cancel()
      releaseNavigation.open()
      releaseCatchUp.open()
      await startup.value
      await closing.value
    }
    await fulfillment(of: [navigationStarted], timeout: 2)
    let cached = try store.sidebar.stateStore.get(store.sidebar.presentation)
    XCTAssertEqual(cached.projects.map(\.project.name), ["Cached Project"])
    XCTAssertEqual(cached.projects.first?.section.rows.map(\.title), ["Recent cached chat"])
    XCTAssertTrue(store.projects.isExpanded(projectID))
    XCTAssertTrue(cached.chats.isEmpty)
    XCTAssertEqual(
      store.list.threads(agentID: storeAgentID, archived: false).map(\.title),
      ["Recent cached chat"])

    releaseNavigation.open()
    await fulfillment(of: [catchUpStarted], timeout: 2)
    let expected = ["Recent cached chat"]
    XCTAssertEqual(
      store.list.threads(agentID: storeAgentID, archived: false).map(\.title), expected)
    releaseCatchUp.open()
    await startup.value
    XCTAssertEqual(
      store.list.threads(agentID: storeAgentID, archived: false).map(\.title), expected)
    XCTAssertEqual(
      store.list.threads(agentID: storeAgentID, archived: true).map(\.title),
      ["Archived cached chat"])
    XCTAssertNil(store.list.error)
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
          "chatThreadId":"\(storeThreadID)","agentId":"\(storeAgentID)",\
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

  func testStartupRestoresNavigationAndChatsBeforeNetworkAndPersistsFreshNavigation() async throws {
    let cacheDirectory = CacheTestDirectory(owner: self)
    let updated = Mutex(false)
    let started = expectation(description: "Fresh navigation is held after cache restore")
    let gate = HTTPResponseGate()
    defer { gate.open() }
    let otherAgent = "40000000-0000-4000-8000-000000000005"
    let fixture = ChatHTTPFixture { request in
      let fresh = updated.withLock { $0 }
      switch request.url?.path {
      case "/api/agents":
        if fresh {
          started.fulfill()
          await gate.wait()
        }
        return ChatHTTPResponse(
          body: """
            [{"agentId":"\(storeAgentID)","isDefaultAgent":true,"displayName":"\(fresh ? "Fresh assistant" : "Cached assistant")"},
            {"agentId":"\(otherAgent)","isDefaultAgent":false,"displayName":"Other assistant"}]
            """)
      case "/api/chat-threads/snapshot": return threadSnapshot(title: "Cached chat")
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: #"{"events":[],"hasMore":false}"#)
      case "/api/indicators":
        return ChatHTTPResponse(body: #"{"agents":{},"threads":{},"unreadAt":{}}"#)
      case "/api/realtime/token":
        return ChatHTTPResponse(status: 403, body: #"{"error":{"message":"No live updates"}}"#)
      default: throw URLError(.unsupportedURL)
      }
    }
    let scope = ChatCacheScope(
      apiBaseURL: fixture.baseURL, userID: "user", workspaceID: "workspace")
    let previous = WorkspaceStore(
      client: fixture.client, webURL: fixture.baseURL,
      cache: cacheDirectory.cache(scope: scope))
    await previous.start(userID: "user", workspaceID: "workspace")
    previous.close()
    updated.withLock { $0 = true }
    let store = WorkspaceStore(
      client: fixture.client, webURL: fixture.baseURL,
      cache: cacheDirectory.cache(scope: scope))
    defer { store.close() }
    let startup = Task { await store.start(userID: "user", workspaceID: "workspace") }
    addTeardownBlock {
      startup.cancel()
      gate.open()
      await startup.value
    }
    await fulfillment(of: [started], timeout: 3)
    try await waitForBusinessResult {
      store.selectedAgentID == storeAgentID
    }
    XCTAssertEqual(store.currentAgentName, "Cached assistant")
    // The cached navigation stays committed while the fresh Agent response is pending.
    let reader = cacheDirectory.cache(scope: scope)
    let held = try await reader.loadNavigation()
    XCTAssertEqual(held?.agents.first?.displayName, "Cached assistant")
    await reader.close()
    XCTAssertEqual(
      store.list.threads(agentID: storeAgentID, archived: false).map(\.title), ["Cached chat"])
    gate.open()
    await startup.value
    XCTAssertEqual(store.currentAgentName, "Fresh assistant")
    XCTAssertEqual(store.selectedAgentID, storeAgentID)
    store.close()

    let reopened = WorkspaceStore(
      client: fixture.client, webURL: fixture.baseURL,
      cache: cacheDirectory.cache(scope: scope))
    defer { reopened.close() }
    await reopened.list.restoreCached()
    XCTAssertEqual(reopened.list.agents.first?.displayName, "Fresh assistant")
    XCTAssertEqual(reopened.selectedAgentID, storeAgentID)
  }

  func testClosingOrCancellingStartupKeepsCachedChatsAndStopsNavigationPublication() async throws {
    for cancelStartup in [false, true] {
      let cacheDirectory = CacheTestDirectory(owner: self)
      let navigationStarted = expectation(
        description: "Independent navigation reads start after cached chats")
      let releaseNavigation = HTTPResponseGate()
      defer { releaseNavigation.open() }
      let fixture = ChatHTTPFixture { request in
        switch request.url?.path {
        case "/api/agents":
          navigationStarted.fulfill()
          await releaseNavigation.wait()
          return ChatHTTPResponse(
            body: """
              [{"agentId":"\(storeAgentID)","isDefaultAgent":true,"displayName":"Okou"}]
              """)
        case "/api/chat-threads/snapshot": return threadSnapshot(title: "Cached chat")
        case "/api/chat-threads/events":
          return ChatHTTPResponse(body: #"{"events":[],"hasMore":false}"#)
        case "/api/indicators":
          return ChatHTTPResponse(body: #"{"agents":{},"unreadAt":{},"threads":{}}"#)
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
      let store = WorkspaceStore(
        client: fixture.client, webURL: fixture.baseURL, cache: cache)
      defer { store.close() }
      let startup = Task { await store.start(userID: "user", workspaceID: "workspace") }
      await fulfillment(of: [navigationStarted], timeout: 2)
      XCTAssertEqual(store.list.threads.map(\.title), ["Cached chat"])

      if cancelStartup {
        startup.cancel()
      } else {
        store.close()
      }
      releaseNavigation.open()
      await startup.value

      XCTAssertEqual(store.list.threads.map(\.title), ["Cached chat"])
      XCTAssertTrue(store.list.agents.isEmpty)
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
          body: "{\"agents\":{},\"unreadAt\":{},\"threads\":{\"\(storeThreadID)\":\"unread\"}}")
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
        return ChatHTTPResponse(body: "{\"agents\":{},\"unreadAt\":{},\"threads\":{}}")
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
