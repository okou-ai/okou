import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class WorkspaceStoreTests: XCTestCase {
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
    XCTAssertTrue(store.threads.isEmpty)
    XCTAssertNil(store.navigationError)
  }

  func testClosingOrCancellingStartupStopsReadsAfterCachedNavigation() async throws {
    for cancelStartup in [false, true] {
      let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
        "okou-startup-tests-\(UUID().uuidString)", isDirectory: true)
      defer { try? FileManager.default.removeItem(at: directory) }
      let navigationStarted = expectation(description: "Cached chats are visible during navigation")
      let releaseNavigation = HTTPResponseGate()
      defer { releaseNavigation.open() }
      let requests = Mutex<[String]>([])
      let fixture = ChatHTTPFixture { request in
        requests.withLock { $0.append(request.url?.path ?? "") }
        switch request.url?.path {
        case "/api/agents":
          navigationStarted.fulfill()
          await releaseNavigation.wait()
          return ChatHTTPResponse(
            body: """
              [{"agentId":"\(storeAgentID)","isDefaultAgent":true,"displayName":"Okou"}]
              """)
        case "/api/realtime/token":
          return ChatHTTPResponse(
            status: 403, body: "{\"error\":{\"message\":\"No live updates\"}}")
        default: throw URLError(.unsupportedURL)
        }
      }
      let cache = ChatCache(
        scope: ChatCacheScope(
          apiBaseURL: fixture.baseURL, userID: "user", workspaceID: "workspace"),
        directory: directory)
      try await cache.replaceThreadList(
        snapshot: Data(threadSnapshot(title: "Cached chat").body.utf8),
        cursor: ChatCacheCursor(eventID: nil, seqID: 0), events: [])
      let store = WorkspaceStore(
        client: fixture.client, webURL: fixture.baseURL, cacheDirectory: directory)
      defer { store.close() }
      let startup = Task { await store.start(userID: "user", workspaceID: "workspace") }
      await fulfillment(of: [navigationStarted], timeout: 2)
      XCTAssertEqual(store.threads.map(\.title), ["Cached chat"])

      if cancelStartup {
        startup.cancel()
      } else {
        store.close()
      }
      releaseNavigation.open()
      await startup.value

      XCTAssertEqual(store.threads.map(\.title), ["Cached chat"])
      XCTAssertTrue(store.agents.isEmpty)
      XCTAssertNil(store.navigationError)
      XCTAssertTrue(
        requests.withLock {
          $0.allSatisfy { $0 == "/api/agents" || $0 == "/api/realtime/token" }
        })
    }
  }

  func testSidebarUsesPinnedAgentsAndTracksSelectedChatAgent() async {
    let otherAgentID = "40000000-0000-4000-8000-000000000006"
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/agents":
        return ChatHTTPResponse(
          body: """
            [{"agentId":"\(storeAgentID)","isDefaultAgent":true,"displayName":"Okou"},{"agentId":"\(otherAgentID)","isDefaultAgent":false,"displayName":"Second"}]
            """)
      case "/api/user-preferences":
        return ChatHTTPResponse(body: "{\"pinnedAgentIds\":[\"\(otherAgentID)\"]}")
      case "/api/feature-switches":
        return ChatHTTPResponse(body: "{\"effectiveSwitches\":{\"chatThreadArchiving\":true}}")
      case "/api/chat-threads/snapshot": return threadSnapshot(title: "Existing chat")
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
      case "/api/indicators":
        return ChatHTTPResponse(body: "{\"agents\":{},\"threads\":{}}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let store = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
    defer { store.close() }
    await store.refreshNavigation()
    await store.refresh()
    XCTAssertEqual(store.visiblePinnedAgents.map(\.agentId), [storeAgentID, otherAgentID])
    XCTAssertEqual(store.currentAgentName, "Okou")
    XCTAssertTrue(store.canArchiveChats)

    store.startNewChat(agentID: otherAgentID)
    XCTAssertEqual(store.currentAgentName, "Second")
    XCTAssertNil(store.selectedThreadID)

    store.selectChat(storeThreadID)
    XCTAssertEqual(store.selectedAgentID, storeAgentID)
    XCTAssertEqual(store.selectedThreadID, storeThreadID)
  }

  func testSelectedChatReassignmentUpdatesAgentContextAndNewChat() async {
    let otherAgentID = "40000000-0000-4000-8000-000000000006"
    let reassigned = Mutex(false)
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/chat-threads/snapshot":
        let url = URL(string: "/thread-snapshot", relativeTo: request.url!)!.absoluteURL
        return ChatHTTPResponse(
          body: """
            {"url":"\(url.absoluteString)","latestEventId":null,"latestSeqId":null}
            """)
      case "/thread-snapshot": return threadSnapshot(title: "Reassigned chat")
      case "/api/chat-threads/events":
        guard reassigned.withLock({ $0 }) else {
          return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
        }
        return ChatHTTPResponse(
          body: """
            {"events":[{"id":"40000000-0000-4000-8000-000000000007","seqId":1,\
            "kind":"sort_touched","chatThreadId":"\(storeThreadID)",\
            "agentId":"\(storeAgentID)","reassignedAgentId":"\(otherAgentID)",\
            "createdAt":"\(storeDate)"}],"hasMore":false}
            """)
      case "/api/indicators": return ChatHTTPResponse(body: "{\"threads\":{}}")
      case "/api/chat-threads/\(storeThreadID)/event-snapshot":
        return ChatHTTPResponse(
          status: 404,
          body: """
            {"error":{"code":"CHAT_EVENT_SNAPSHOT_NOT_FOUND","message":"No snapshot"}}
            """)
      case "/api/chat-threads/\(storeThreadID)/event-rows":
        return ChatHTTPResponse(
          body: "{\"rows\":[],\"cursor\":{\"lastEventId\":null,\"lastSeqId\":0},\"hasMore\":false}")
      case "/api/chat-threads/\(storeThreadID)":
        return ChatHTTPResponse(body: "{\"cancellationRecoveryPending\":false}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let store = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
    defer { store.close() }
    await store.refresh()
    store.selectChat(storeThreadID)
    XCTAssertEqual(store.selectedAgentID, storeAgentID)

    reassigned.withLock { $0 = true }
    await store.refresh()

    XCTAssertEqual(store.selectedThreadID, storeThreadID)
    XCTAssertEqual(store.threads.first?.agentID, otherAgentID)
    XCTAssertEqual(store.selectedAgentID, otherAgentID)
    XCTAssertNil(store.error)
    XCTAssertNil(store.threadErrors[storeThreadID])
    store.startNewChat()
    XCTAssertNil(store.selectedThreadID)
    XCTAssertEqual(store.selectedAgentID, otherAgentID)

    // An explicit new-chat agent selection remains independent of list updates.
    store.startNewChat(agentID: storeAgentID)
    await store.refresh()
    XCTAssertEqual(store.selectedAgentID, storeAgentID)
  }

  func testNewChatDoesNotCreateUntilSendAndKeepsDraftIfCreationFails() async {
    let requests = Mutex<[String]>([])
    let fixture = ChatHTTPFixture { request in
      requests.withLock { $0.append(request.url?.path ?? "") }
      return ChatHTTPResponse(status: 503, body: "{\"error\":{\"message\":\"Unavailable\"}}")
    }
    let store = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
    defer { store.close() }
    store.selectedThreadID = storeThreadID
    store.newChatDraft = "Old draft"

    store.startNewChat()
    XCTAssertNil(store.selectedThreadID)
    XCTAssertEqual(store.newChatDraft, "")
    XCTAssertTrue(requests.withLock { $0.isEmpty })

    store.newChatDraft = "First message"
    await store.sendNewChat()
    XCTAssertNil(store.selectedThreadID)
    XCTAssertEqual(store.newChatDraft, "First message")
    XCTAssertFalse(requests.withLock { $0.isEmpty })
    XCTAssertNotNil(store.error)
  }

  func testRefreshDuringOldHistoryReadRendersFinalAnswer() async throws {
    let oldReadStarted = expectation(description: "The old history response is in flight")
    let releaseOldResponse = HTTPResponseGate()
    defer { releaseOldResponse.open() }
    let historyReads = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/chat-threads/\(storeThreadID)/event-snapshot":
        return ChatHTTPResponse(
          status: 404,
          body:
            "{\"error\":{\"code\":\"CHAT_EVENT_SNAPSHOT_NOT_FOUND\",\"message\":\"No snapshot\"}}")
      case "/api/chat-threads/\(storeThreadID)/event-rows":
        let cursor = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
          .queryItems?.first { $0.name == "sinceSeqId" }?.value
        if cursor == "3" { return historyPage(rows: [], lastSequence: 3) }
        let firstRead = historyReads.withLock {
          $0 += 1
          return $0 == 1
        }
        if firstRead {
          oldReadStarted.fulfill()
          await releaseOldResponse.wait()
          return historyPage(
            rows: [
              historyEvent(
                sequence: 1, type: "input.prompt",
                payload: """
                  {"userMessage":{"version":1,"parts":[{"type":"text","text":"Hello"}]}}
                  """)
            ],
            lastSequence: 1)
        }
        return historyPage(
          rows: [
            historyEvent(
              sequence: 2, type: "output.message", payload: "{\"content\":\"Final answer\"}"),
            historyEvent(sequence: 3, type: "run.completed"),
          ], lastSequence: 3)
      case "/api/chat-threads/\(storeThreadID)":
        return ChatHTTPResponse(body: "{\"lastReadAt\":null,\"cancellationRecoveryPending\":false}")
      case "/api/chat-threads/snapshot": return threadSnapshot(title: "Existing chat")
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
      case "/api/indicators":
        return ChatHTTPResponse(body: "{\"agents\":{},\"threads\":{}}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let store = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
    defer { store.close() }
    store.selectedThreadID = storeThreadID
    let initialRead = Task { await store.loadHistory(storeThreadID) }
    await fulfillment(of: [oldReadStarted], timeout: 2)

    // A final-result invalidation enters refresh while the detail view's old read is pending.
    // Awaiting the reconciler makes the ordering deterministic without a live Ably connection.
    await store.refresh()
    releaseOldResponse.open()
    await initialRead.value

    XCTAssertEqual(store.messages(for: storeThreadID).map(\.text), ["Hello", "Final answer"])
    XCTAssertEqual(store.messages(for: storeThreadID).last?.role, .assistant)
    XCTAssertEqual(store.histories[storeThreadID]?.executionState, .completed)
    XCTAssertNil(store.threadErrors[storeThreadID])
  }

  func testRefreshDuringOldListReadRendersLatestTitle() async throws {
    let oldReadStarted = expectation(description: "The old chat list response is in flight")
    let releaseOldResponse = HTTPResponseGate()
    defer { releaseOldResponse.open() }
    let snapshotReads = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/chat-threads/snapshot":
        let firstRead = snapshotReads.withLock {
          $0 += 1
          return $0 == 1
        }
        if firstRead {
          oldReadStarted.fulfill()
          await releaseOldResponse.wait()
          return threadSnapshot(title: "Original title")
        }
        return threadSnapshot(title: "Latest title")
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
      case "/api/indicators":
        return ChatHTTPResponse(body: "{\"agents\":{},\"threads\":{}}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let store = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
    defer { store.close() }
    let initialRead = Task { await store.refresh() }
    await fulfillment(of: [oldReadStarted], timeout: 2)

    await store.refresh()
    releaseOldResponse.open()
    await initialRead.value

    XCTAssertEqual(store.threads.map(\.id), [storeThreadID])
    XCTAssertEqual(store.threads.map(\.title), ["Latest title"])
    XCTAssertNil(store.error)
  }

  func testDelayedCreateResponsePreservesOneLatestThreadFromList() async throws {
    let createStarted = expectation(description: "Create has committed but its response is delayed")
    let releaseCreateResponse = HTTPResponseGate()
    defer { releaseCreateResponse.open() }
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/agents":
        return ChatHTTPResponse(
          body: """
            [{"agentId":"\(storeAgentID)","isDefaultAgent":true,"ownerId":"test-user","description":null,"displayName":"Okou","sound":null,"avatarUrl":null,"visibility":"private"}]
            """)
      case "/api/user-model-preference":
        return ChatHTTPResponse(
          body: """
            {"selectedModel":null,"serviceTier":null,"modelSettings":{},"selectedImageModel":null,"updatedAt":null}
            """)
      case "/api/run-models": return runModelsResponse()
      case "/api/model-catalog": return modelCatalogResponse()
      case "/api/chat-threads":
        guard request.httpMethod == "POST" else { throw URLError(.unsupportedURL) }
        createStarted.fulfill()
        await releaseCreateResponse.wait()
        return ChatHTTPResponse(
          status: 201,
          body: """
            {"id":"\(storeThreadID)","title":null,"createdAt":"\(storeDate)","selectedModel":"okou-1.0","serviceTier":null}
            """)
      case "/api/chat-threads/snapshot": return threadSnapshot(title: "Latest title")
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
      case "/api/indicators":
        return ChatHTTPResponse(body: "{\"agents\":{},\"threads\":{}}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let store = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
    defer { store.close() }
    let creation = Task { await store.createChat() }
    await fulfillment(of: [createStarted], timeout: 2)

    await store.refresh()
    XCTAssertEqual(store.threads.map(\.title), ["Latest title"])
    releaseCreateResponse.open()
    await creation.value

    XCTAssertEqual(store.threads.map(\.id), [storeThreadID])
    XCTAssertEqual(store.threads.map(\.title), ["Latest title"])
    XCTAssertEqual(store.selectedThreadID, storeThreadID)
    XCTAssertNil(store.error)
  }

  func testHistoryMarksReadOnlyForVisibleForegroundThread() async throws {
    let unread = Mutex(true)
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/chat-threads/snapshot": return threadSnapshot(title: "Unread reply")
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
      case "/api/indicators":
        let indicators = unread.withLock { $0 ? "\"\(storeThreadID)\":\"unread\"" : "" }
        return ChatHTTPResponse(body: "{\"agents\":{},\"threads\":{\(indicators)}}")
      case "/api/chat-threads/\(storeThreadID)/event-snapshot":
        return ChatHTTPResponse(
          status: 404,
          body:
            "{\"error\":{\"code\":\"CHAT_EVENT_SNAPSHOT_NOT_FOUND\",\"message\":\"No snapshot\"}}")
      case "/api/chat-threads/\(storeThreadID)/event-rows":
        let cursor = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
          .queryItems?.first { $0.name == "sinceSeqId" }?.value
        let rows =
          cursor == "0"
          ? [
            historyEvent(
              sequence: 1, type: "output.message", payload: "{\"content\":\"Unread answer\"}"),
            historyEvent(sequence: 2, type: "run.completed"),
          ] : []
        return historyPage(rows: rows, lastSequence: 2)
      case "/api/chat-threads/\(storeThreadID)":
        return ChatHTTPResponse(body: "{\"lastReadAt\":null,\"cancellationRecoveryPending\":false}")
      case "/api/chat-threads/\(storeThreadID)/mark-read":
        guard request.httpMethod == "POST" else { throw URLError(.unsupportedURL) }
        unread.withLock { $0 = false }
        return ChatHTTPResponse(status: 204, body: "")
      default: throw URLError(.unsupportedURL)
      }
    }
    let store = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
    defer { store.close() }
    await store.refresh()

    store.selectedThreadID = storeThreadID
    store.setForeground(false)
    await store.loadHistory(storeThreadID)
    XCTAssertEqual(store.messages(for: storeThreadID).map(\.text), ["Unread answer"])
    XCTAssertEqual(store.threads.first?.indicator, .unread)
    XCTAssertTrue(unread.withLock { $0 })

    store.setForeground(true)
    store.selectedThreadID = "40000000-0000-4000-8000-000000000004"
    await store.loadHistory(storeThreadID)
    XCTAssertEqual(store.threads.first?.indicator, .unread)
    XCTAssertTrue(unread.withLock { $0 })

    store.selectedThreadID = storeThreadID
    await store.loadHistory(storeThreadID)
    XCTAssertNil(store.threads.first?.indicator)
    XCTAssertNil(store.threadErrors[storeThreadID])

    // Reloading the list verifies the cleared badge reflects the HTTP mark-read result.
    store.selectedThreadID = nil
    await store.refresh()
    XCTAssertNil(store.threads.first?.indicator)
    XCTAssertNil(store.error)
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
        return ChatHTTPResponse(body: "{\"threads\":{\"\(storeThreadID)\":\"unread\"}}")
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
            historyEvent(sequence: 2, type: "run.completed"),
          ], lastSequence: 2)
      case "/api/chat-threads/\(storeThreadID)":
        return ChatHTTPResponse(body: "{\"cancellationRecoveryPending\":false}")
      case "/api/chat-threads/\(storeThreadID)/mark-read":
        oldMarkReadRequests.withLock { $0.append(request.httpMethod ?? "") }
        return ChatHTTPResponse(status: 204, body: "")
      default: throw URLError(.unsupportedURL)
      }
    }
    let oldStore = WorkspaceStore(client: oldFixture.client, webURL: oldFixture.baseURL)
    defer { oldStore.close() }
    await oldStore.refresh()
    oldStore.setForeground(true)
    oldStore.selectedThreadID = storeThreadID
    let oldRead = Task { await oldStore.loadHistory(storeThreadID) }
    await fulfillment(of: [oldReadStarted], timeout: 2)
    oldStore.close()

    let freshFixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/chat-threads/snapshot": return threadSnapshot(title: "Fresh workspace chat")
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
      case "/api/indicators": return ChatHTTPResponse(body: "{\"threads\":{}}")
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
            historyEvent(sequence: 2, type: "run.completed"),
          ], lastSequence: 2)
      case "/api/chat-threads/\(storeThreadID)":
        return ChatHTTPResponse(body: "{\"cancellationRecoveryPending\":false}")
      default: throw URLError(.unsupportedURL)
      }
    }
    // The same thread identity deliberately verifies that history caches belong to each store.
    let freshStore = WorkspaceStore(client: freshFixture.client, webURL: freshFixture.baseURL)
    defer { freshStore.close() }
    freshStore.setForeground(true)
    freshStore.selectedThreadID = storeThreadID
    await freshStore.refresh()
    XCTAssertEqual(freshStore.messages(for: storeThreadID).map(\.text), ["Fresh workspace answer"])

    releaseOldResponse.open()
    await oldRead.value

    XCTAssertTrue(oldStore.messages(for: storeThreadID).isEmpty)
    XCTAssertTrue(oldMarkReadRequests.withLock { $0.isEmpty })
    XCTAssertEqual(freshStore.messages(for: storeThreadID).map(\.text), ["Fresh workspace answer"])
    XCTAssertEqual(freshStore.threads.map(\.title), ["Fresh workspace chat"])
    XCTAssertNil(freshStore.error)
    XCTAssertNil(freshStore.threadErrors[storeThreadID])
  }

  func testRetryReconcilesPersistedInputIncludingRevokedInputWithoutResending() async throws {
    struct SentInput: Decodable, Sendable {
      let clientEventId: String
      let prompt: String
    }
    for revoked in [false, true] {
      let sentInputs = Mutex<[SentInput]>([])
      let fixture = ChatHTTPFixture { request in
        switch request.url?.path {
        case "/api/chat-threads/snapshot": return threadSnapshot(title: "Existing chat")
        case "/api/chat-threads/events":
          return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
        case "/api/indicators": return ChatHTTPResponse(body: "{\"threads\":{}}")
        case "/api/chat-threads/\(storeThreadID)/connector-selections":
          return ChatHTTPResponse(body: "{\"selections\":[],\"selectedConnections\":[]}")
        case "/api/chat-threads/\(storeThreadID)/metadata":
          return ChatHTTPResponse(
            body: """
              {"id":"\(storeThreadID)","agentId":"\(storeAgentID)","title":"Existing chat","selectedModel":"gpt-5.6-sol","computerUseHostId":null,"cloudBrowserEnabled":false}
              """)
        case "/api/chat/events":
          guard request.httpMethod == "POST" else { throw URLError(.unsupportedURL) }
          let input = try JSONDecoder().decode(SentInput.self, from: chatRequestBody(request))
          sentInputs.withLock { $0.append(input) }
          // The server accepted this identity, but the response never reaches the client.
          throw URLError(.networkConnectionLost)
        case "/api/chat-threads/\(storeThreadID)/event-snapshot":
          return ChatHTTPResponse(
            status: 404,
            body:
              "{\"error\":{\"code\":\"CHAT_EVENT_SNAPSHOT_NOT_FOUND\",\"message\":\"No snapshot\"}}"
          )
        case "/api/chat-threads/\(storeThreadID)/event-rows":
          guard let input = sentInputs.withLock({ $0.first }) else {
            throw URLError(.badServerResponse)
          }
          let lastSequence = revoked ? 2 : 3
          let cursor = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
            .queryItems?.first { $0.name == "sinceSeqId" }?.value
          if cursor == String(lastSequence) {
            return historyPage(rows: [], lastSequence: lastSequence)
          }
          var rows = [
            historyEvent(
              sequence: 1, type: "input.prompt",
              payload: """
                {"userMessage":{"version":1,"parts":[{"type":"text","text":"\(input.prompt)"}]}}
                """,
              id: input.clientEventId, runID: revoked ? nil : storeRunID)
          ]
          if revoked {
            rows.append(
              historyEvent(
                sequence: 2, type: "control.revoke", runID: nil,
                revokesEventID: input.clientEventId))
          } else {
            rows.append(
              historyEvent(
                sequence: 2, type: "output.message", payload: "{\"content\":\"Received\"}"))
            rows.append(historyEvent(sequence: 3, type: "run.completed"))
          }
          return historyPage(rows: rows, lastSequence: lastSequence)
        case "/api/chat-threads/\(storeThreadID)":
          return ChatHTTPResponse(body: "{\"cancellationRecoveryPending\":false}")
        default: throw URLError(.unsupportedURL)
        }
      }
      let store = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
      defer { store.close() }
      await store.refresh()
      let thread = try XCTUnwrap(store.threads.first)
      store.drafts[thread.id] = "Check status"
      await store.send(in: thread)
      let pending = try XCTUnwrap(store.pending[thread.id]?.first)
      XCTAssertTrue(pending.needsRetry)
      XCTAssertEqual(store.messages(for: thread.id).map(\.text), ["Check status"])
      XCTAssertEqual(sentInputs.withLock { $0.map(\.clientEventId) }, [pending.id])

      await store.retry(pending, in: thread)

      XCTAssertEqual(
        store.messages(for: thread.id).map(\.text),
        revoked ? [] : ["Check status", "Received"], "Revoked input: \(revoked)")
      XCTAssertTrue(store.pending[thread.id]?.isEmpty == true, "Revoked input: \(revoked)")
      XCTAssertNil(store.threadErrors[thread.id])
      XCTAssertEqual(
        sentInputs.withLock { $0.map(\.clientEventId) }, [pending.id],
        "An accepted identity must not be submitted again after history reconciliation")
    }
  }
}

/// Releases a suspended HTTP response without blocking URLProtocol's delivery queue.
private final class HTTPResponseGate: Sendable {
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

private let storeThreadID = "40000000-0000-4000-8000-000000000001"
private let storeAgentID = "40000000-0000-4000-8000-000000000002"
private let storeRunID = "40000000-0000-4000-8000-000000000003"
private let storeDate = "2026-09-17T10:00:00.000Z"

private func historyEvent(
  sequence: Int, type: String, payload: String = "null", id: String? = nil,
  runID: String? = storeRunID, revokesEventID: String? = nil
) -> String {
  """
  {"id":"\(id ?? storeEventID(sequence))","chatThreadId":"\(storeThreadID)","runId":\(runID.map { "\"\($0)\"" } ?? "null"),"revokesEventId":\(revokesEventID.map { "\"\($0)\"" } ?? "null"),"contextType":null,"contextId":null,"runEventSequenceNumber":null,"runEventId":null,"seqId":\(sequence),"createdAt":"\(storeDate)","eventType":"\(type)","payload":\(payload)}
  """
}

private func historyPage(rows: [String], lastSequence: Int) -> ChatHTTPResponse {
  ChatHTTPResponse(
    body: """
      {"rows":[\(rows.joined(separator: ","))],"cursor":{"lastEventId":"\(storeEventID(lastSequence))","lastSeqId":\(lastSequence)},"hasMore":false}
      """)
}

private func storeEventID(_ sequence: Int) -> String {
  String(format: "50000000-0000-4000-8000-%012d", sequence)
}

private func threadSnapshot(title: String) -> ChatHTTPResponse {
  ChatHTTPResponse(
    body: """
      {"chatThreads":[{"id":"\(storeThreadID)","agentId":"\(storeAgentID)","title":"\(title)","sortAt":"\(storeDate)","createdAt":"\(storeDate)","updatedAt":"\(storeDate)","pinnedAt":null,"renamedAt":null,"selectedModel":"gpt-5.6-sol","serviceTier":null,"computerUseHostId":null,"cloudBrowserEnabled":false}],"latestEventId":null,"latestSeqId":null}
      """)
}
