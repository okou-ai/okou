import ChatData
import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class WorkspaceStoreTests: XCTestCase {

  func testSidebarDraftMarksComeFromTheAPIAndFromAnOpenChatsComposer() async throws {
    let otherID = "40000000-0000-4000-8000-000000000009"
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/chat-threads/snapshot":
        return threadSnapshot(title: "Drafts", threadIDs: [storeThreadID, otherID])
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: #"{"events":[],"hasMore":false}"#)
      case "/api/indicators":
        return ChatHTTPResponse(body: #"{"threads":{},"unreadAt":{}}"#)
      case "/api/chat-thread-drafts":
        return ChatHTTPResponse(body: #"{"draftThreadIds":["\#(storeThreadID)","\#(otherID)"]}"#)
      case "/api/chat-drafts/composer", "/api/chat-threads/\(storeThreadID)/draft":
        return ChatHTTPResponse(body: #"{"draftUserMessage":null,"draftAttachments":null}"#)
      case "/api/chat-threads/\(storeThreadID)/event-snapshot": return missingHistorySnapshot()
      case "/api/chat-threads/\(storeThreadID)/event-rows":
        let rows = [
          historyEvent(sequence: 1, type: "output.message", payload: #"{"content":"Answer"}"#)
        ]
        return historyPage(rows: rows, lastSequence: 1)
      case "/api/chat-threads/\(storeThreadID)":
        return ChatHTTPResponse(body: #"{"cancellationRecoveryPending":false}"#)
      default: throw URLError(.unsupportedURL)
      }
    }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let storage = ChatDraftStorage(
      scope: ChatCacheScope(
        apiBaseURL: fixture.baseURL, userID: "user", workspaceID: "workspace"),
      directory: directory)
    let store = WorkspaceStore(
      client: fixture.client, webURL: fixture.baseURL, draftStorage: storage)
    defer { store.close() }
    store.setPhase(.active)
    await store.refresh()
    await store.activateDrafts()
    XCTAssertTrue(store.hasDraft(storeThreadID))
    XCTAssertTrue(store.hasDraft(otherID))

    // An open chat answers from its own composer, ahead of the API's list.
    store.selectChat(storeThreadID)
    let conversation = try XCTUnwrap(store.selectedConversation)
    await conversation.composer.synchronize()
    XCTAssertFalse(store.hasDraft(storeThreadID))
    conversation.draft = "Unsent words"
    XCTAssertTrue(store.hasDraft(storeThreadID))
    conversation.draft = "  "
    XCTAssertFalse(store.hasDraft(storeThreadID))
    XCTAssertTrue(store.hasDraft(otherID))
  }

  func testBackgroundWarmingIncludesRecentAndActiveUnopenedChats() async throws {
    let cacheDirectory = CacheTestDirectory(owner: self)
    let warmingScheduled = expectation(description: "History warming is scheduled")
    let releaseWarming = HTTPResponseGate()
    defer { releaseWarming.open() }
    let ids = (1...102).map { String(format: "72000000-0000-4000-8000-%012d", $0) }
    let activeID = ids[0]
    let batchStarted = expectation(description: "Unopened chats are warmed in one batch")
    let observed = Mutex<[String]>([])
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/chat-threads/snapshot": return threadSnapshot(title: "Recent chat", threadIDs: ids)
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
      case "/api/indicators":
        return ChatHTTPResponse(
          body: "{\"unreadAt\":{},\"threads\":{\"\(activeID)\":\"active\"}}")
      case "/api/chat/events/catch-up":
        let body = try XCTUnwrap(
          JSONSerialization.jsonObject(with: chatRequestBody(request)) as? [[Any]])
        let requested = try body.map { try XCTUnwrap($0.first as? String) }
        observed.withLock { $0 = requested }
        batchStarted.fulfill()
        let events = requested.map { "\"\($0)\":[]" }.joined(separator: ",")
        return ChatHTTPResponse(body: "{\"events\":{\(events)},\"notFoundThreads\":[]}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let store = WorkspaceStore(
      client: fixture.client, webURL: fixture.baseURL,
      cache: cacheDirectory.cache(
        scope: ChatCacheScope(
          apiBaseURL: fixture.baseURL, userID: "user", workspaceID: "workspace")),
      historyWarmingSleep: { _ in
        warmingScheduled.fulfill()
        await releaseWarming.wait()
        try Task.checkCancellation()
      })
    defer { store.close() }
    await store.refresh([.startup])
    XCTAssertNil(store.selectedConversation)
    await fulfillment(of: [warmingScheduled], timeout: 3)
    releaseWarming.open()
    await fulfillment(of: [batchStarted], timeout: 3)
    XCTAssertEqual(Set(observed.withLock { $0 }), Set([activeID] + Array(ids.suffix(100))))
    XCTAssertNil(store.selectedConversation)
    XCTAssertNil(store.list.error)
  }

  func testBackgroundUpgradeResponseBlocksFurtherWorkspaceReads() async throws {
    let cacheDirectory = CacheTestDirectory(owner: self)
    let warmingScheduled = expectation(description: "History warming is scheduled")
    let releaseWarming = HTTPResponseGate()
    defer { releaseWarming.open() }
    let requests = Mutex<[String]>([])
    let fixture = ChatHTTPFixture { request in
      requests.withLock { $0.append(request.url?.path ?? "") }
      switch request.url?.path {
      case "/api/chat-threads/snapshot": return threadSnapshot(title: "Chat")
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
      case "/api/indicators":
        return ChatHTTPResponse(body: "{\"unreadAt\":{},\"threads\":{}}")
      case "/api/chat/events/catch-up":
        return ChatHTTPResponse(status: 426, body: "{\"error\":{\"message\":\"Update required\"}}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let store = WorkspaceStore(
      client: fixture.client, webURL: fixture.baseURL,
      cache: cacheDirectory.cache(
        scope: ChatCacheScope(
          apiBaseURL: fixture.baseURL, userID: "user", workspaceID: "workspace")),
      historyWarmingSleep: { _ in
        warmingScheduled.fulfill()
        await releaseWarming.wait()
        try Task.checkCancellation()
      })
    defer { store.close() }
    await store.refresh([.startup])
    await fulfillment(of: [warmingScheduled], timeout: 3)
    releaseWarming.open()
    try await waitForBusinessResult { store.needsUpgrade }
    let before = requests.withLock { $0 }
    await store.refresh()
    XCTAssertEqual(requests.withLock { $0 }, before)
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
        let timestamps =
          unread.withLock { $0 } ? "\"\(storeThreadID)\":\"2026-09-17T12:00:00Z\"" : ""
        return ChatHTTPResponse(
          body: "{\"unreadAt\":{\(timestamps)},\"threads\":{\(indicators)}}")
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
            historyEvent(sequence: 2, type: "run.completed")
          ] : []
        return historyPage(rows: rows, lastSequence: 2)
      case "/api/chat-threads/\(storeThreadID)":
        return ChatHTTPResponse(body: "{\"lastReadAt\":null,\"cancellationRecoveryPending\":false}")
      case "/api/chat-threads/\(storeThreadID)/mark-read":
        guard request.httpMethod == "POST" else { throw URLError(.unsupportedURL) }
        unread.withLock { $0 = false }
        return ChatHTTPResponse(body: "{\"lastReadAt\":\"2026-09-17T12:00:00Z\"}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let store = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
    defer { store.close() }
    await store.refresh()

    store.selectedThreadID = storeThreadID
    store.setPhase(.background)
    await store.conversation(for: storeThreadID)?.refresh()
    XCTAssertEqual(
      (store.conversation(for: storeThreadID)?.messages ?? []).map(\.text), ["Unread answer"])
    XCTAssertEqual(store.list.threads.first?.indicator, .unread)
    XCTAssertTrue(unread.withLock { $0 })

    store.setPhase(.active)
    store.selectedThreadID = "40000000-0000-4000-8000-000000000004"
    await store.conversation(for: storeThreadID)?.refresh()
    XCTAssertEqual(store.list.threads.first?.indicator, .unread)
    XCTAssertTrue(unread.withLock { $0 })

    store.selectedThreadID = storeThreadID
    store.sidebarInteraction.setOpen(false)
    await store.conversation(for: storeThreadID)?.refresh()
    XCTAssertNil(store.list.threads.first?.indicator)
    XCTAssertNil(store.conversation(for: storeThreadID)?.error)

    // Reloading the list verifies the cleared badge reflects the HTTP mark-read result.
    store.selectedThreadID = nil
    await store.refresh()
    XCTAssertNil(store.list.threads.first?.indicator)
    XCTAssertNil(store.error)
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
        case "/api/indicators":
          return ChatHTTPResponse(body: "{\"unreadAt\":{},\"threads\":{}}")
        case "/api/chat-threads/\(storeThreadID)/connector-selections":
          return ChatHTTPResponse(body: "{\"selections\":[],\"selectedConnections\":[]}")
        case "/api/chat-threads/\(storeThreadID)/metadata":
          return ChatHTTPResponse(
            body: """
              {"id":"\(storeThreadID)","title":"Existing chat","selectedModel":"gpt-5.6-sol","computerUseHostId":null,"cloudBrowserEnabled":false}
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
      let thread = try XCTUnwrap(store.list.threads.first)
      store.conversation(for: thread.id)?.draft = "Check status"
      await store.conversation(for: thread.id)?.send()
      let pending = try XCTUnwrap(store.conversation(for: thread.id)?.pending.first)
      XCTAssertTrue(pending.needsRetry)
      XCTAssertEqual(
        (store.conversation(for: thread.id)?.messages ?? []).map(\.text), ["Check status"])
      XCTAssertEqual(sentInputs.withLock { $0.map(\.clientEventId) }, [pending.id])

      await store.reduceMemory()
      XCTAssertEqual(store.conversation(for: thread.id)?.pending.first?.id, pending.id)

      await store.conversation(for: thread.id)?.retry(pending)

      XCTAssertEqual(
        (store.conversation(for: thread.id)?.messages ?? []).map(\.text),
        revoked ? [] : ["Check status", "Received"], "Revoked input: \(revoked)")
      XCTAssertTrue(
        store.conversation(for: thread.id)?.pending.isEmpty == true, "Revoked input: \(revoked)")
      XCTAssertNil(store.conversation(for: thread.id)?.error)
      XCTAssertEqual(
        sentInputs.withLock { $0.map(\.clientEventId) }, [pending.id],
        "An accepted identity must not be submitted again after history reconciliation")
    }
  }

  func testMemoryWarningPreservesDraftsAndRestoresReleasedHistoryFromSQLite() async throws {
    let otherID = "40000000-0000-4000-8000-000000000010"
    let cacheDirectory = CacheTestDirectory(owner: self)
    let snapshotRequests = Mutex<[String]>([])
    let fixture = ChatHTTPFixture { request in
      let path = request.url?.path ?? ""
      switch path {
      case "/api/chat-threads/snapshot":
        return threadSnapshot(title: "Chat", threadIDs: [storeThreadID, otherID])
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
      case "/api/indicators":
        return ChatHTTPResponse(body: "{\"unreadAt\":{},\"threads\":{}}")
      default:
        let id = path.contains(otherID) ? otherID : storeThreadID
        if path.hasSuffix("/event-snapshot") {
          snapshotRequests.withLock { $0.append(id) }
          return missingHistorySnapshot()
        }
        if path.hasSuffix("/event-rows") {
          let since = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
            .queryItems?.first { $0.name == "sinceSeqId" }?.value
          let rows =
            since == "0"
            ? [
              historyEvent(
                sequence: 1, type: "output.message", payload: "{\"content\":\"Saved reply\"}"),
              historyEvent(sequence: 2, type: "run.completed")
            ] : []
          var response = historyPage(rows: rows, lastSequence: 2)
          response.body = response.body.replacingOccurrences(of: storeThreadID, with: id)
          return response
        }
        if path == "/api/chat-threads/\(id)" {
          return ChatHTTPResponse(body: "{\"cancellationRecoveryPending\":false}")
        }
        throw URLError(.unsupportedURL)
      }
    }
    let cache = cacheDirectory.cache(
      scope: ChatCacheScope(
        apiBaseURL: fixture.baseURL,
        userID: "user", workspaceID: "workspace"))
    let store = WorkspaceStore(
      client: fixture.client, webURL: fixture.baseURL,
      cache: cache, conversationLimit: 1)
    defer { store.close() }
    await store.refresh()
    store.selectChat(storeThreadID)
    let original = try XCTUnwrap(store.selectedConversation)
    await original.refresh()
    original.draft = "Keep my draft"
    store.selectChat(otherID)
    await store.selectedConversation?.refresh()
    await store.reduceMemory()
    let retained = try XCTUnwrap(store.conversation(for: storeThreadID))
    XCTAssertEqual(retained.draft, "Keep my draft")
    XCTAssertEqual(retained.messages.map(\.text), ["Saved reply"])

    retained.draft = ""
    await store.reduceMemory()
    let restored = try XCTUnwrap(store.conversation(for: storeThreadID))
    await restored.refresh()
    XCTAssertEqual(restored.draft, "")
    XCTAssertEqual(restored.messages.map(\.text), ["Saved reply"])
    XCTAssertEqual(snapshotRequests.withLock { $0.filter { $0 == storeThreadID }.count }, 1)
    XCTAssertEqual(store.selectedThreadID, otherID)
  }

  func testAuxiliaryUpgradeResponseBlocksAllFurtherWorkspaceReads() async {
    for endpoint in [
      "/api/indicators"
    ] {
      let requests = Mutex<[String]>([])
      let fixture = ChatHTTPFixture { request in
        let path = request.url?.path ?? ""
        requests.withLock { $0.append(path) }
        if path == endpoint {
          return ChatHTTPResponse(
            status: 426, body: "{\"error\":{\"message\":\"Update required\"}}")
        }
        switch path {
        case "/api/chat-threads/snapshot": return threadSnapshot(title: "Chat")
        case "/api/chat-threads/events":
          return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
        default: throw URLError(.unsupportedURL)
        }
      }
      let store = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
      defer { store.close() }
      if endpoint == "/api/indicators" {
        await store.refresh()
      } else {
        await store.prepareWorkspaceComposer()
      }
      XCTAssertTrue(store.needsUpgrade, endpoint)
      let before = requests.withLock { $0 }
      await store.prepareWorkspaceComposer()
      await store.refresh()
      XCTAssertEqual(requests.withLock { $0 }, before)
    }
  }

}

@MainActor
final class WorkspaceRefreshTests: XCTestCase {
  func testForegroundConversationPublishesNewMessagesWhileSidebarIndicatorsAreStillPending()
    async throws
  {
    let updated = Mutex(false)
    let pendingSidebar = Mutex(false)
    let sidebarStarted = expectation(description: "Sidebar indicators are held")
    let releaseSidebar = HTTPResponseGate()
    defer { releaseSidebar.open() }
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/chat-threads/snapshot": return threadSnapshot(title: "Priority conversation")
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: #"{"events":[],"hasMore":false}"#)
      case "/api/indicators":
        if pendingSidebar.withLock({ $0 }) {
          sidebarStarted.fulfill()
          await releaseSidebar.wait()
        }
        return ChatHTTPResponse(body: #"{"threads":{},"unreadAt":{}}"#)
      case "/api/chat-threads/\(storeThreadID)/event-snapshot": return missingHistorySnapshot()
      case "/api/chat-threads/\(storeThreadID)/event-rows":
        let after =
          URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first {
            $0.name == "sinceSeqId"
          }?.value.flatMap(Int.init) ?? 0
        let last = updated.withLock { $0 ? 4 : 2 }
        let rows = (1...last).filter { $0 > after }.map { sequence in
          sequence.isMultiple(of: 2)
            ? historyEvent(sequence: sequence, type: "run.completed")
            : historyEvent(
              sequence: sequence, type: "output.message",
              payload: sequence == 1
                ? #"{"content":"Cached answer"}"# : #"{"content":"Fresh answer"}"#)
        }
        return historyPage(rows: rows, lastSequence: last)
      case "/api/chat-threads/\(storeThreadID)":
        return ChatHTTPResponse(body: #"{"cancellationRecoveryPending":false}"#)
      case "/api/chat-threads/\(storeThreadID)/mark-read":
        return ChatHTTPResponse(body: #"{"lastReadAt":"2026-10-26T00:00:00Z"}"#)
      default: throw URLError(.unsupportedURL)
      }
    }
    let store = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
    defer { store.close() }
    store.setPhase(.active)
    await store.list.refresh()
    store.selectedThreadID = storeThreadID
    let conversation = try XCTUnwrap(store.selectedConversation)
    await conversation.refresh()
    XCTAssertEqual(conversation.messages.map(\.text), ["Cached answer"])
    updated.withLock { $0 = true }
    pendingSidebar.withLock { $0 = true }
    let refresh = Task { await store.refresh() }
    addTeardownBlock { @MainActor in
      store.close()
      refresh.cancel()
      releaseSidebar.open()
      await refresh.value
    }
    await fulfillment(of: [sidebarStarted], timeout: 3)
    try await waitForBusinessResult { conversation.messages.contains { $0.text == "Fresh answer" } }
    releaseSidebar.open()
    await refresh.value
    XCTAssertNil(conversation.error)
  }

  func testHistoryRefreshPreservesTheComposerAndForegroundRecoveryLoadsOtherDeviceChanges()
    async throws
  {
    let remoteDraft = Mutex("First device draft")
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/chat-threads/snapshot": return threadSnapshot(title: "Draft recovery")
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
      case "/api/indicators":
        return ChatHTTPResponse(body: "{\"unreadAt\":{},\"threads\":{}}")
      case "/api/chat-thread-drafts":
        return ChatHTTPResponse(body: #"{"draftThreadIds":[]}"#)
      case "/api/chat-drafts/composer":
        return ChatHTTPResponse(body: "{\"draftUserMessage\":null,\"draftAttachments\":null}")
      case "/api/chat-threads/\(storeThreadID)/draft":
        return ChatHTTPResponse(
          body: """
            {"draftUserMessage":{"version":1,"parts":[{"type":"text",\
            "text":"\(remoteDraft.withLock { $0 })"}]},"draftAttachments":null}
            """)
      case "/api/chat-threads/\(storeThreadID)/event-snapshot": return missingHistorySnapshot()
      case "/api/chat-threads/\(storeThreadID)/event-rows":
        let after = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
          .queryItems?.first { $0.name == "sinceSeqId" }?.value
        let rows =
          after == "0"
          ? [
            historyEvent(sequence: 1, type: "output.message", payload: "{\"content\":\"Answer\"}")
          ] : []
        return historyPage(rows: rows, lastSequence: 1)
      case "/api/chat-threads/\(storeThreadID)":
        return ChatHTTPResponse(body: "{\"cancellationRecoveryPending\":false}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let storage = ChatDraftStorage(
      scope: ChatCacheScope(
        apiBaseURL: fixture.baseURL, userID: "user", workspaceID: "workspace"),
      directory: directory)
    let store = WorkspaceStore(
      client: fixture.client, webURL: fixture.baseURL, draftStorage: storage)
    defer { store.close() }
    store.setPhase(.active)
    await store.refresh()
    store.selectChat(storeThreadID)
    let conversation = try XCTUnwrap(store.selectedConversation)
    await conversation.composer.synchronize()
    await conversation.refresh()
    XCTAssertEqual(conversation.draft, "First device draft")

    remoteDraft.withLock { $0 = "Changed on the other device" }
    await store.refresh()
    XCTAssertEqual(conversation.messages.map(\.text), ["Answer"])
    XCTAssertEqual(conversation.draft, "First device draft")

    store.setPhase(.background)
    store.setPhase(.active)
    await conversation.composer.synchronize()
    XCTAssertEqual(conversation.draft, "Changed on the other device")
    XCTAssertNil(conversation.composer.error)
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
            historyEvent(sequence: 3, type: "run.completed")
          ], lastSequence: 3)
      case "/api/chat-threads/\(storeThreadID)":
        return ChatHTTPResponse(body: "{\"lastReadAt\":null,\"cancellationRecoveryPending\":false}")
      case "/api/chat-threads/snapshot": return threadSnapshot(title: "Existing chat")
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
      case "/api/indicators":
        return ChatHTTPResponse(body: "{\"unreadAt\":{},\"threads\":{}}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let store = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
    defer { store.close() }
    await store.list.refresh()
    store.selectedThreadID = storeThreadID
    let initialRead = Task { await store.conversation(for: storeThreadID)?.refresh() }
    addTeardownBlock {
      initialRead.cancel()
      releaseOldResponse.open()
      _ = await initialRead.value
    }
    await fulfillment(of: [oldReadStarted], timeout: 2)

    // A final-result invalidation enters refresh while the detail view's old read is pending.
    let refresh = Task.immediate { await store.refresh() }
    addTeardownBlock {
      refresh.cancel()
      releaseOldResponse.open()
      await refresh.value
    }
    releaseOldResponse.open()
    await refresh.value
    await initialRead.value

    XCTAssertEqual(
      (store.conversation(for: storeThreadID)?.messages ?? []).map(\.text),
      ["Hello", "Final answer"])
    XCTAssertEqual((store.conversation(for: storeThreadID)?.messages ?? []).last?.role, .assistant)
    XCTAssertEqual(store.conversation(for: storeThreadID)?.history?.executionState, .completed)
    XCTAssertNil(store.conversation(for: storeThreadID)?.error)
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
        return ChatHTTPResponse(body: "{\"unreadAt\":{},\"threads\":{}}")
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

    XCTAssertEqual(store.list.threads.map(\.id), [storeThreadID])
    XCTAssertEqual(store.list.threads.map(\.title), ["Latest title"])
    XCTAssertNil(store.error)
  }

  func testTargetedInvalidationRefreshesItsConversationWithoutReloadingTheSelectedHistory()
    async throws
  {
    let otherID = "40000000-0000-4000-8000-000000000010"
    let requests = Mutex<[String]>([])
    let updated = Mutex(false)
    let fixture = ChatHTTPFixture { request in
      let path = request.url?.path ?? ""
      requests.withLock { $0.append(path) }
      switch path {
      case "/api/chat-threads/snapshot":
        return threadSnapshot(title: "Chat", threadIDs: [storeThreadID, otherID])
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
      case "/api/indicators":
        return ChatHTTPResponse(body: "{\"unreadAt\":{},\"threads\":{}}")
      default:
        let id = path.contains(otherID) ? otherID : storeThreadID
        if path.hasSuffix("/event-snapshot") { return missingHistorySnapshot() }
        if path.hasSuffix("/event-rows") {
          let since = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
            .queryItems?.first { $0.name == "sinceSeqId" }?.value
          let hasUpdate = id == otherID && updated.withLock { $0 }
          let last = hasUpdate ? 4 : 2
          let rows: [String]
          if since == "0" {
            rows = [
              historyEvent(
                sequence: 1, type: "output.message",
                payload: "{\"content\":\"Initial \(id)\"}"),
              historyEvent(sequence: 2, type: "run.completed")
            ]
          } else if since == "2", hasUpdate {
            rows = [
              historyEvent(
                sequence: 3, type: "output.message",
                payload: "{\"content\":\"Latest reply\"}"),
              historyEvent(sequence: 4, type: "run.completed")
            ]
          } else {
            rows = []
          }
          var response = historyPage(rows: rows, lastSequence: last)
          response.body = response.body.replacingOccurrences(of: storeThreadID, with: id)
          return response
        }
        if path == "/api/chat-threads/\(id)" {
          return ChatHTTPResponse(body: "{\"cancellationRecoveryPending\":false}")
        }
        throw URLError(.unsupportedURL)
      }
    }
    let store = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
    defer { store.close() }
    await store.refresh()
    store.selectChat(storeThreadID)
    let selected = try XCTUnwrap(store.selectedConversation)
    await selected.refresh()
    let other = try XCTUnwrap(store.conversation(for: otherID))
    await other.refresh()
    updated.withLock { $0 = true }
    requests.withLock { $0.removeAll() }

    let invalidation = try XCTUnwrap(
      ChatInvalidation(notification: "chatThreadMessageCreated:\(otherID)"))
    await store.refresh([invalidation])

    XCTAssertEqual(selected.messages.map(\.text), ["Initial \(storeThreadID)"])
    XCTAssertEqual(other.messages.map(\.text), ["Initial \(otherID)", "Latest reply"])
    XCTAssertEqual(store.selectedThreadID, storeThreadID)
    XCTAssertEqual(
      Set(requests.withLock { $0 }),
      [
        "/api/chat-threads/\(otherID)/event-rows", "/api/chat-threads/\(otherID)"
      ])

    requests.withLock { $0.removeAll() }
    await store.refresh([.threadList])
    XCTAssertFalse(requests.withLock { $0.contains { $0.hasSuffix("/event-rows") } })
    requests.withLock { $0.removeAll() }
    await store.refresh([.reconnected])
    XCTAssertTrue(
      requests.withLock { $0.contains("/api/chat-threads/\(storeThreadID)/event-rows") })
    XCTAssertTrue(requests.withLock { $0.contains("/api/chat-threads/events") })
  }

}
