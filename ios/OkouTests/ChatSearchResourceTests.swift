import ChatData
import ChatDataTestSupport
import ChatDomain
import Observation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class ChatSearchResourceTests: XCTestCase {
  func testWorkspaceTitleSearchOrderingLimitAndCrossAgentOpeningPreservesHistory() async throws {
    let fixture = SearchUnreadFixture()
    let store = fixture.workspace()
    defer { store.close() }
    await store.refreshNavigation()
    await store.refresh()
    store.search.present()
    store.search.updateQuery("  chat  ")
    let titles = store.search.titleResults(in: store.list.threads)
    XCTAssertEqual(titles.count, 25)
    XCTAssertEqual(titles.first?.id, SearchUnreadFixture.id(40))
    XCTAssertTrue(titles.contains { $0.agentID == SearchUnreadFixture.otherAgent })

    let id = SearchUnreadFixture.id(2)
    store.selectChat(id)
    let conversation = try XCTUnwrap(store.selectedConversation)
    await conversation.refresh()
    while conversation.hasEarlierMessages { await conversation.loadEarlierMessages() }
    let position = ConversationReadingPosition(messageID: SearchUnreadFixture.rowID(5), offset: 17)
    conversation.rememberReadingPosition(position)
    store.selectChat(SearchUnreadFixture.id(1))
    store.search.updateQuery("needle")
    let hits = try await store.search.stateStore.get(store.search.messagesValue).value
    XCTAssertEqual(hits.first?.matchedMessage.seqId, 5)
    let opened = await store.openSearchResult(id)
    XCTAssertTrue(opened)
    XCTAssertEqual(store.selectedAgentID, SearchUnreadFixture.otherAgent)
    let selected = try XCTUnwrap(store.selectedConversation)
    XCTAssertEqual(selected.thread.id, id)
    XCTAssertEqual(selected.readingPosition, position)
    XCTAssertTrue(selected.visibleMessages.contains { $0.id == position.messageID })
    XCTAssertFalse(store.search.isPresented)
    XCTAssertNil(store.error)
  }

  func testOpeningSearchResultAwaitsAnAlreadyRunningListRefresh() async {
    let started = expectation(description: "Startup list request is in flight")
    let gate = SearchResponseGate()
    defer { gate.open() }
    let requests = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      if let empty = emptySearchResources(request) { return empty }
      switch request.url?.path {
      case "/api/chat-threads/snapshot":
        let first = requests.withLock {
          $0 += 1
          return $0 == 1
        }
        if first {
          started.fulfill()
          await gate.wait()
        }
        return ChatHTTPResponse(
          body: """
            {"chatThreads":[{"id":"\(SearchUnreadFixture.id(2))","agentId":"\(SearchUnreadFixture.otherAgent)","title":"Chat","createdAt":"\(SearchUnreadFixture.timestamp)","updatedAt":"\(SearchUnreadFixture.timestamp)","sortAt":"\(SearchUnreadFixture.timestamp)"}],"latestEventId":null,"latestSeqId":null}
            """)
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
      case "/api/indicators":
        return ChatHTTPResponse(body: "{\"agents\":{},\"threads\":{},\"unreadAt\":{}}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let store = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
    defer { store.close() }
    let startup = Task { await store.list.refresh() }
    addTeardownBlock {
      startup.cancel()
      gate.open()
      await startup.value
    }
    await fulfillment(of: [started], timeout: 2)
    store.search.present()
    let opening = Task.immediate { await store.openSearchResult(SearchUnreadFixture.id(2)) }
    addTeardownBlock {
      opening.cancel()
      gate.open()
      _ = await opening.value
    }
    XCTAssertNil(store.selectedThreadID)
    gate.open()
    let opened = await opening.value
    await startup.value
    XCTAssertTrue(opened)
    XCTAssertEqual(store.selectedThreadID, SearchUnreadFixture.id(2))
    XCTAssertEqual(store.selectedAgentID, SearchUnreadFixture.otherAgent)
    XCTAssertNil(store.list.error)
    XCTAssertNil(store.search.openingError)
  }

  func testSearchDebounceReplacementClearingDismissalAndWorkspaceIsolation() async throws {
    let started = expectation(description: "Old search started")
    let cancelled = expectation(description: "The old search handler observed cancellation")
    let gate = SearchResponseGate()
    defer { gate.open() }
    let seen = Mutex<[String]>([])
    let fixture = ChatHTTPFixture { request in
      if let empty = emptySearchResources(request) { return empty }
      XCTAssertNil(query(request, "agentId"))
      XCTAssertEqual(
        request.value(forHTTPHeaderField: "Authorization"), "Bearer local-test-session")
      let keyword = query(request, "keyword") ?? ""
      seen.withLock { $0.append(keyword) }
      if keyword == "old" {
        started.fulfill()
        await gate.wait()
        XCTAssertTrue(Task.isCancelled)
        cancelled.fulfill()
      }
      return searchResponse(content: keyword)
    }
    let search = ChatSearchStore(sync: ChatSync(client: fixture.client), didFail: { _ in })
    defer { search.close() }
    search.present()
    search.updateQuery("discarded")
    let discarded = try search.stateStore.get(search.messagesValue)
    search.updateQuery("old")
    let old = try search.stateStore.get(search.messagesValue)
    addTeardownBlock { @MainActor in
      search.close()
      gate.open()
      _ = await discarded.result
      _ = await old.result
    }
    await fulfillment(of: [started], timeout: 2)
    search.updateQuery("new")
    let newest = try await search.stateStore.get(search.messagesValue).value
    XCTAssertEqual(newest.first?.matchedMessage.content, "new")
    gate.open()
    await fulfillment(of: [cancelled], timeout: 2)
    let retained = try await search.stateStore.get(search.messagesValue).value
    XCTAssertEqual(retained.first?.matchedMessage.content, "new")
    XCTAssertFalse(seen.withLock { $0.contains("discarded") })
    search.updateQuery("")
    let cleared = try await search.stateStore.get(search.messagesValue).value
    XCTAssertTrue(cleared.isEmpty)
    search.updateQuery("closed")
    let dismissed = try search.stateStore.get(search.messagesValue)
    search.dismiss()
    _ = await dismissed.result
    XCTAssertFalse(search.isPresented)
    let afterDismissal = try await search.stateStore.get(search.messagesValue).value
    XCTAssertTrue(afterDismissal.isEmpty)

    let fresh = SearchUnreadFixture().workspace()
    defer { fresh.close() }
    let freshResults = try await fresh.search.stateStore.get(fresh.search.messagesValue).value
    XCTAssertTrue(freshResults.isEmpty)
    XCTAssertFalse(fresh.search.isPresented)
    XCTAssertTrue(fresh.search.query.isEmpty)
  }

  func testDismissedSearchCannotNavigateWhenItsPendingListReadFinishes() async throws {
    let started = expectation(description: "Search is refreshing a missing result's thread")
    let gate = SearchResponseGate()
    defer { gate.open() }
    let fixture = ChatHTTPFixture { request in
      if let empty = emptySearchResources(request) { return empty }
      switch request.url?.path {
      case "/api/chat-threads/snapshot":
        started.fulfill()
        await gate.wait()
        return ChatHTTPResponse(
          body: "{\"chatThreads\":[],\"latestEventId\":null,\"latestSeqId\":null}")
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
      case "/api/indicators":
        return ChatHTTPResponse(body: "{\"agents\":{},\"threads\":{},\"unreadAt\":{}}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let store = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
    defer { store.close() }
    store.search.present()
    let opening = Task { await store.openSearchResult(SearchUnreadFixture.id(2)) }
    await fulfillment(of: [started], timeout: 2)
    store.search.dismiss()
    gate.open()
    let opened = await opening.value
    XCTAssertFalse(opened)
    XCTAssertNil(store.selectedThreadID)
    XCTAssertNil(store.search.openingError)
  }

  func testOpeningSearchResultKeepsRefreshFailuresDistinctFromMissingThreads() async {
    let failing = Mutex(true)
    let fixture = ChatHTTPFixture { request in
      if let empty = emptySearchResources(request) { return empty }
      switch request.url?.path {
      case "/api/chat-threads/snapshot":
        if failing.withLock({ $0 }) {
          return ChatHTTPResponse(
            status: 503, body: "{\"error\":{\"message\":\"List unavailable\"}}")
        }
        return ChatHTTPResponse(
          body: "{\"chatThreads\":[],\"latestEventId\":null,\"latestSeqId\":null}")
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
      case "/api/indicators":
        return ChatHTTPResponse(body: "{\"agents\":{},\"threads\":{},\"unreadAt\":{}}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let store = WorkspaceStore(
      client: fixture.client, webURL: fixture.baseURL, readRetrySleep: { _ in })
    defer { store.close() }
    store.search.present()
    let failed = await store.openSearchResult(SearchUnreadFixture.id(2))
    XCTAssertFalse(failed)
    do {
      try await store.list.stateStore.get(store.list.listValue).value
      XCTFail("Search must retain the list failure instead of reporting a missing chat")
    } catch {
      XCTAssertEqual((error as? APIClientError)?.statusCode, 503)
    }
    XCTAssertNil(store.search.openingError)
    XCTAssertNil(store.selectedThreadID)
    failing.withLock { $0 = false }
    let missing = await store.openSearchResult(SearchUnreadFixture.id(2))
    XCTAssertFalse(missing)
    XCTAssertNil(store.list.error)
    do {
      try await store.list.stateStore.get(store.list.listValue).value
    } catch {
      XCTFail("A missing chat follows a successful list read: \(error)")
    }
    XCTAssertNotNil(store.search.openingError)
    XCTAssertNil(store.selectedThreadID)
    failing.withLock { $0 = true }
    let failedAgain = await store.openSearchResult(SearchUnreadFixture.id(2))
    XCTAssertFalse(failedAgain)
    do {
      try await store.list.stateStore.get(store.list.listValue).value
      XCTFail("A later failed list read must remain available to the search status")
    } catch {
      XCTAssertEqual((error as? APIClientError)?.statusCode, 503)
    }
    XCTAssertNil(store.search.openingError)
  }

  func testWorkflowsLoadOnceWithoutBuiltInsAndArtifactsFollowTheQuery() async throws {
    let workflowLoads = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      guard request.httpMethod == "GET" else { throw URLError(.unsupportedURL) }
      switch request.url?.path {
      case "/api/workflows":
        workflowLoads.withLock { $0 += 1 }
        return ChatHTTPResponse(
          body: """
            [{"id":"w1","agentId":"a","name":"brand-design","displayName":"Brand Design","description":"Posters","official":null},
             {"id":"w2","agentId":"a","name":"built-in","displayName":null,"description":null,"official":{"readOnly":true}}]
            """)
      case "/api/artifacts/catalog":
        XCTAssertEqual(query(request, "keyword"), "brand")
        return ChatHTTPResponse(
          body: """
            {"artifacts":[{"id":"x","kind":"hosted-site","title":"Brand site","thumbnail":null,"sourceUrl":"https://dpl-1.sites.vm0.io","aliasUrl":"https://brand.sites.vm0.io"},
                          {"id":"y","kind":"shared-thread","title":"Shared chat","thumbnail":null,"sharedThreadId":"s"}],
             "nextCursor":null}
            """)
      case "/api/chat/search":
        return ChatHTTPResponse(body: "{\"results\":[]}")
      default:
        throw URLError(.unsupportedURL)
      }
    }
    let search = ChatSearchStore(sync: ChatSync(client: fixture.client), didFail: { _ in })
    defer { search.close() }
    search.present()
    let initial = try await search.stateStore.get(search.workflowsValue).value
    XCTAssertEqual(initial.map(\.id), ["w1"])
    search.updateQuery("brand")
    let messages = try search.stateStore.get(search.messagesValue)
    let artifacts = try search.stateStore.get(search.artifactsValue)
    _ = try await messages.value
    let found = try await artifacts.value
    // A shared conversation is left out: the app cannot open it.
    XCTAssertEqual(found.map(\.title), ["Brand site"])
    XCTAssertEqual(found.map(\.aliasUrl), ["https://brand.sites.vm0.io"])
    XCTAssertEqual(found.map(\.kind), ["hosted-site"])
    let matching = try await search.stateStore.get(search.workflowsValue).value
    XCTAssertEqual(matching.map(\.id), ["w1"])
    search.updateQuery("nothing like it")
    let filtered = try await search.stateStore.get(search.workflowsValue).value
    XCTAssertTrue(filtered.isEmpty)
    XCTAssertEqual(workflowLoads.withLock { $0 }, 1)
  }

  func testEmptyDeniedFailedAndRetriedMessageSearch() async throws {
    let attempt = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      if let empty = emptySearchResources(request) { return empty }
      switch query(request, "keyword") {
      case "empty": return ChatHTTPResponse(body: "{\"results\":[]}")
      case "denied":
        return ChatHTTPResponse(status: 403, body: "{\"error\":{\"message\":\"Forbidden\"}}")
      default:
        let current = attempt.withLock {
          $0 += 1
          return $0
        }
        return current == 1
          ? ChatHTTPResponse(status: 503, body: "{\"error\":{\"message\":\"Try later\"}}")
          : searchResponse(content: "Recovered")
      }
    }
    let search = ChatSearchStore(sync: ChatSync(client: fixture.client), didFail: { _ in })
    defer { search.close() }
    search.present()
    search.updateQuery("empty")
    let empty = try await search.stateStore.get(search.messagesValue).value
    XCTAssertTrue(empty.isEmpty)
    for (keyword, status) in [("denied", 403), ("retry", 503)] {
      search.updateQuery(keyword)
      do {
        _ = try await search.stateStore.get(search.messagesValue).value
        XCTFail("The failed search must retain its HTTP error")
      } catch let error as APIClientError {
        XCTAssertEqual(error.statusCode, status)
      }
    }
    search.retry()
    let recovered = try await search.stateStore.get(search.messagesValue).value
    XCTAssertEqual(recovered.first?.matchedMessage.content, "Recovered")
  }

  func testSearchResourcesFinishIndependentlyAndRetainTheirOwnFailure() async throws {
    let messagesGate = SearchResponseGate()
    let workflowsGate = SearchResponseGate()
    defer {
      messagesGate.open()
      workflowsGate.open()
    }
    let pending = expectation(description: "Messages and workflows reached their external gates")
    pending.expectedFulfillmentCount = 2
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/chat/search":
        pending.fulfill()
        await messagesGate.wait()
        return ChatHTTPResponse(status: 403, body: #"{"error":{"message":"Forbidden"}}"#)
      case "/api/workflows":
        pending.fulfill()
        await workflowsGate.wait()
        return ChatHTTPResponse(
          body:
            #"[{"id":"workflow","agentId":"agent","name":"brand-design","displayName":"Brand Design","description":"Posters","official":null}]"#
        )
      case "/api/artifacts/catalog":
        return ChatHTTPResponse(
          body:
            #"{"artifacts":[{"id":"site","kind":"hosted-site","title":"Brand site","thumbnail":null,"aliasUrl":"https://brand.sites.vm0.io"}],"nextCursor":null}"#
        )
      default: throw URLError(.unsupportedURL)
      }
    }
    let search = ChatSearchStore(sync: ChatSync(client: fixture.client), didFail: { _ in })
    defer { search.close() }
    search.present()
    search.updateQuery("brand")
    let workflows = try search.stateStore.get(search.workflowsValue)
    let messages = try search.stateStore.get(search.messagesValue)
    let artifacts = try search.stateStore.get(search.artifactsValue)
    addTeardownBlock { @MainActor in
      search.close()
      messagesGate.open()
      workflowsGate.open()
      _ = await workflows.result
      _ = await messages.result
      _ = await artifacts.result
    }
    await fulfillment(of: [pending], timeout: 2)
    // The artifact is usable while both other endpoints are still pending.
    let found = try await artifacts.value
    XCTAssertEqual(found.map(\.title), ["Brand site"])
    messagesGate.open()
    do {
      _ = try await messages.value
      XCTFail("A denied message search must not become a successful empty result")
    } catch let error as APIClientError {
      XCTAssertEqual(error.statusCode, 403)
    }
    workflowsGate.open()
    let available = try await workflows.value
    XCTAssertEqual(available.map(\.id), ["workflow"])
  }

  func testDismissalCancelsEveryInFlightSearchResource() async throws {
    let gates = Dictionary(
      uniqueKeysWithValues: ["/api/chat/search", "/api/workflows", "/api/artifacts/catalog"].map {
        ($0, SearchResponseGate())
      })
    defer { for gate in gates.values { gate.open() } }
    let pending = expectation(description: "All search resources reached HTTP")
    pending.expectedFulfillmentCount = 3
    let cancelled = expectation(description: "Every original HTTP request observed cancellation")
    cancelled.expectedFulfillmentCount = 3
    let fixture = ChatHTTPFixture { request in
      guard let gate = gates[request.url?.path ?? ""] else { throw URLError(.unsupportedURL) }
      pending.fulfill()
      await gate.wait()
      XCTAssertTrue(Task.isCancelled)
      cancelled.fulfill()
      return emptySearchResources(request) ?? ChatHTTPResponse(body: #"{"results":[]}"#)
    }
    let search = ChatSearchStore(sync: ChatSync(client: fixture.client), didFail: { _ in })
    defer { search.close() }
    search.present()
    search.updateQuery("pending")
    let workflows = try search.stateStore.get(search.workflowsValue)
    let messages = try search.stateStore.get(search.messagesValue)
    let artifacts = try search.stateStore.get(search.artifactsValue)
    addTeardownBlock { @MainActor in
      search.close()
      for gate in gates.values { gate.open() }
      _ = await workflows.result
      _ = await messages.result
      _ = await artifacts.result
    }
    await fulfillment(of: [pending], timeout: 2)
    search.dismiss()
    await fulfillment(of: [cancelled], timeout: 2)
    XCTAssertFalse(search.isPresented)
    XCTAssertTrue(search.query.isEmpty)
  }

  func testArtifactSearchUpgradeClosesTheWorkspace() async throws {
    let fixture = ChatHTTPFixture { request in
      guard request.url?.path == "/api/artifacts/catalog" else {
        throw URLError(.unsupportedURL)
      }
      return ChatHTTPResponse(status: 426, body: #"{"error":{"message":"Update required"}}"#)
    }
    let workspace = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
    defer { workspace.close() }
    workspace.search.present()
    workspace.search.updateQuery("brand")
    let pending = try workspace.search.stateStore.get(workspace.search.artifactsValue)
    let outcome = await pending.result
    guard case .failure(let error) = outcome else {
      return XCTFail("The resource must retain the force-upgrade error")
    }
    XCTAssertEqual((error as? APIClientError)?.statusCode, 426)
    XCTAssertTrue(workspace.needsUpgrade)
    XCTAssertFalse(workspace.search.isPresented)
  }
}
