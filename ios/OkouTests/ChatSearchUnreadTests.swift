import ChatData
import ChatDataTestSupport
import ChatDomain
import Observation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class ChatSearchUnreadTests: XCTestCase {
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
    try await waitForBusinessResult { !store.search.isLoading }
    XCTAssertEqual(store.search.messages.first?.matchedMessage.seqId, 5)
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

  func testBulkReadBlocksConcurrentChangesAndRecoversAfterFailure() async throws {
    let fixture = SearchUnreadFixture()
    let store = fixture.workspace()
    defer { store.close() }
    await store.refreshNavigation()
    await store.refresh()
    let agent = SearchUnreadFixture.agent
    let otherThread = try XCTUnwrap(
      store.list.threads.first { $0.id == SearchUnreadFixture.id(2) })
    let started = expectation(description: "Bulk read reached the API")
    let gate = SearchResponseGate()
    defer { gate.open() }
    fixture.state.value.withLock {
      $0.failWrites = true
      $0.bulkReadGate = gate
      $0.bulkReadStarted = { started.fulfill() }
    }
    let pending = Task { await store.list.markAgentRead(agent) }
    await fulfillment(of: [started], timeout: 2)
    XCTAssertTrue(store.list.markingAgentRead)
    await store.list.markAgentRead(SearchUnreadFixture.otherAgent)
    await store.setRead(otherThread, read: true)
    gate.open()
    await pending.value
    XCTAssertFalse(store.list.markingAgentRead)
    XCTAssertTrue(store.list.updatingThreads.isEmpty)
    XCTAssertNotNil(store.list.error)
    XCTAssertTrue(store.list.unreadAgentIDs.contains(agent))
    XCTAssertTrue(store.list.unreadAgentIDs.contains(SearchUnreadFixture.otherAgent))

    fixture.state.value.withLock { $0.failWrites = false }
    await store.list.markAgentRead(agent)
    XCTAssertNil(store.list.error)
    XCTAssertFalse(store.list.markingAgentRead)
    XCTAssertTrue(store.list.updatingThreads.isEmpty)
    XCTAssertFalse(store.list.unreadAgentIDs.contains(agent))
    XCTAssertTrue(store.list.unreadAgentIDs.contains(SearchUnreadFixture.otherAgent))
    XCTAssertTrue(store.list.threads.first { $0.id == otherThread.id }?.isUnread == true)
    XCTAssertEqual(
      store.list.threads.first { $0.id == SearchUnreadFixture.id(1) }?.indicator, .active)
  }

  func testManualUnreadWaitsForAutomaticReadAndSurvivesRefreshUntilReopened() async throws {
    let fixture = SearchUnreadFixture()
    let started = expectation(description: "Automatic read started")
    let gate = SearchResponseGate()
    defer { gate.open() }
    fixture.state.value.withLock {
      $0.readGate = gate
      $0.readStarted = { started.fulfill() }
    }
    let store = fixture.workspace()
    defer { store.close() }
    await store.refresh()
    store.setForeground(true)
    store.selectChat(SearchUnreadFixture.id(1))
    let conversation = try XCTUnwrap(store.selectedConversation)
    let refresh = Task { await conversation.refresh() }
    addTeardownBlock {
      refresh.cancel()
      gate.open()
      await refresh.value
    }
    await fulfillment(of: [started], timeout: 3)
    let thread = try XCTUnwrap(store.list.threads.first { $0.id == SearchUnreadFixture.id(1) })
    let manual = Task { await store.setRead(thread, read: false) }
    addTeardownBlock {
      manual.cancel()
      gate.open()
      await manual.value
    }
    try await waitForBusinessResult { store.list.updatingThreads.contains(thread.id) }
    gate.open()
    await refresh.value
    await manual.value
    XCTAssertEqual(fixture.state.value.withLock { $0.writes }, ["read", "unread"])
    await store.refresh([.readCursor, .history(threadID: thread.id)])
    XCTAssertTrue(store.list.threads.first { $0.id == thread.id }?.isUnread == true)
    XCTAssertEqual(fixture.state.value.withLock { $0.writes }, ["read", "unread"])
    store.selectChat(thread.id)
    await conversation.refresh()
    XCTAssertEqual(fixture.state.value.withLock { $0.writes }, ["read", "unread", "read"])
    XCTAssertFalse(store.list.threads.first { $0.id == thread.id }?.isUnread == true)
  }

  func testNewServerDeliveryCanBeReadAfterManualUnreadWithoutReopening() async throws {
    let fixture = SearchUnreadFixture()
    let store = fixture.workspace()
    defer { store.close() }
    await store.refresh()
    store.setForeground(true)
    store.selectChat(SearchUnreadFixture.id(1))
    await store.selectedConversation?.refresh()
    let thread = try XCTUnwrap(store.list.threads.first { $0.id == SearchUnreadFixture.id(1) })
    await store.setRead(thread, read: false)
    await store.refresh([.readCursor])
    XCTAssertEqual(fixture.state.value.withLock { $0.writes }, ["read", "unread"])
    fixture.state.value.withLock { $0.marker = "2026-10-19T12:01:00Z" }
    await store.refresh([.readCursor])
    XCTAssertEqual(fixture.state.value.withLock { $0.writes }, ["read", "unread", "read"])
    XCTAssertFalse(store.list.threads.first { $0.id == thread.id }?.isUnread == true)
  }

  func testFailedManualActionKeepsAuthoritativeStateAndCanRetry() async throws {
    let fixture = SearchUnreadFixture()
    let store = fixture.workspace()
    defer { store.close() }
    await store.refresh()
    let thread = try XCTUnwrap(store.list.threads.first { $0.id == SearchUnreadFixture.id(2) })
    fixture.state.value.withLock { $0.failWrites = true }
    await store.setRead(thread, read: true)
    XCTAssertTrue(store.list.threads.first { $0.id == thread.id }?.isUnread == true)
    XCTAssertNotNil(store.list.error)
    XCTAssertTrue(store.list.updatingThreads.isEmpty)
    fixture.state.value.withLock { $0.failWrites = false }
    await store.setRead(thread, read: true)
    XCTAssertFalse(store.list.threads.first { $0.id == thread.id }?.isUnread == true)
    XCTAssertNil(store.list.error)
  }

  func testLostUnreadResponseDoesNotLetAutomaticReadOverwriteServerSuccess() async throws {
    let fixture = SearchUnreadFixture()
    let store = fixture.workspace()
    defer { store.close() }
    await store.refresh()
    store.setForeground(true)
    store.selectChat(SearchUnreadFixture.id(1))
    await store.selectedConversation?.refresh()
    let thread = try XCTUnwrap(store.list.threads.first { $0.id == SearchUnreadFixture.id(1) })
    fixture.state.value.withLock { $0.dropUnreadResponse = true }
    await store.setRead(thread, read: false)
    XCTAssertNotNil(store.list.error)
    await store.refresh([.readCursor, .history(threadID: thread.id)])
    XCTAssertTrue(store.list.threads.first { $0.id == thread.id }?.isUnread == true)
    XCTAssertEqual(fixture.state.value.withLock { $0.writes }, ["read", "unread"])
    fixture.state.value.withLock { $0.dropUnreadResponse = false }
    await store.setRead(thread, read: false)
    XCTAssertNil(store.list.error)
    XCTAssertTrue(store.list.threads.first { $0.id == thread.id }?.isUnread == true)
  }

  func testStaleIndicatorRefreshCannotUndoConfirmedRead() async throws {
    let started = expectation(description: "Old indicator request has captured unread state")
    let reconciling = expectation(
      description: "Fresh indicators requested after the stale response")
    let gate = SearchResponseGate()
    let freshGate = SearchResponseGate()
    let count = Mutex(0)
    let read = Mutex(false)
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/chat-threads/snapshot":
        return ChatHTTPResponse(
          body: """
            {"chatThreads":[{"id":"\(SearchUnreadFixture.id(1))","agentId":"\(SearchUnreadFixture.agent)","title":"Chat","createdAt":"\(SearchUnreadFixture.timestamp)","updatedAt":"\(SearchUnreadFixture.timestamp)","sortAt":"\(SearchUnreadFixture.timestamp)"}],"latestEventId":null,"latestSeqId":null}
            """)
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
      case "/api/indicators":
        let alreadyRead = read.withLock { $0 }
        let attempt = count.withLock {
          $0 += 1
          return $0
        }
        if attempt == 2 {
          started.fulfill()
          await gate.wait()
        } else if attempt == 3 {
          reconciling.fulfill()
          await freshGate.wait()
        }
        if alreadyRead {
          return ChatHTTPResponse(body: "{\"agents\":{},\"threads\":{},\"unreadAt\":{}}")
        }
        return ChatHTTPResponse(
          body:
            "{\"agents\":{},\"threads\":{\"\(SearchUnreadFixture.id(1))\":\"unread\"},\"unreadAt\":{\"\(SearchUnreadFixture.id(1))\":\"\(SearchUnreadFixture.timestamp)\"}}"
        )
      case "/api/chat-threads/\(SearchUnreadFixture.id(1))/mark-read":
        read.withLock { $0 = true }
        return ChatHTTPResponse(body: "{\"lastReadAt\":\"\(SearchUnreadFixture.timestamp)\"}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let store = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
    addTeardownBlock { @MainActor in
      gate.open()
      freshGate.open()
      withExtendedLifetime(fixture) { store.close() }
    }
    await store.list.refresh()
    let thread = try XCTUnwrap(store.list.threads.first)
    XCTAssertTrue(thread.isUnread)
    let stale = Task { await store.list.refreshIndicators() }
    addTeardownBlock {
      stale.cancel()
      gate.open()
      freshGate.open()
      await stale.value
    }
    await fulfillment(of: [started], timeout: 2)
    let confirmedRead = Task {
      for await unread in Observations({ store.list.threads.first?.isUnread }) {
        if unread == false { return }
      }
    }
    addTeardownBlock {
      confirmedRead.cancel()
      await confirmedRead.value
    }
    let markingRead = Task {
      await store.setRead(thread, read: true)
      confirmedRead.cancel()
    }
    addTeardownBlock {
      markingRead.cancel()
      gate.open()
      freshGate.open()
      await markingRead.value
    }
    await confirmedRead.value
    XCTAssertFalse(try XCTUnwrap(store.list.threads.first).isUnread)
    // Release the stale response before waiting for the read operation that joins it.
    gate.open()
    await fulfillment(of: [reconciling], timeout: 2)
    // A fresh response must not conceal a stale overwrite of the confirmed read.
    XCTAssertFalse(try XCTUnwrap(store.list.threads.first).isUnread)
    freshGate.open()
    await markingRead.value
    await stale.value
    XCTAssertFalse(store.list.threads.first?.isUnread == true)
    XCTAssertNil(store.list.error)
  }

  func testSearchDebounceReplacementClearingDismissalAndWorkspaceIsolation() async throws {
    let started = expectation(description: "Old search started")
    let cancelled = expectation(description: "The old search handler observed cancellation")
    let gate = SearchResponseGate()
    defer { gate.open() }
    let seen = Mutex<[String]>([])
    let fixture = ChatHTTPFixture { request in
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
    search.updateQuery("old")
    await fulfillment(of: [started], timeout: 2)
    search.updateQuery("new")
    try await waitForBusinessResult { !search.isLoading }
    XCTAssertEqual(search.messages.first?.matchedMessage.content, "new")
    gate.open()
    await fulfillment(of: [cancelled], timeout: 2)
    XCTAssertEqual(search.messages.first?.matchedMessage.content, "new")
    XCTAssertFalse(seen.withLock { $0.contains("discarded") })
    search.updateQuery("")
    XCTAssertTrue(search.messages.isEmpty)
    XCTAssertFalse(search.isLoading)
    search.updateQuery("closed")
    search.dismiss()
    XCTAssertFalse(search.isPresented)
    XCTAssertTrue(search.messages.isEmpty)

    let fresh = SearchUnreadFixture().workspace()
    defer { fresh.close() }
    XCTAssertTrue(fresh.search.messages.isEmpty)
    XCTAssertFalse(fresh.search.isPresented)
    XCTAssertTrue(fresh.search.query.isEmpty)
  }

  func testDismissedSearchCannotNavigateWhenItsPendingListReadFinishes() async throws {
    let started = expectation(description: "Search is refreshing a missing result's thread")
    let gate = SearchResponseGate()
    defer { gate.open() }
    let fixture = ChatHTTPFixture { request in
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
    let store = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
    defer { store.close() }
    store.search.present()
    let failed = await store.openSearchResult(SearchUnreadFixture.id(2))
    XCTAssertFalse(failed)
    XCTAssertNotNil(store.list.error)
    XCTAssertNil(store.search.openingError)
    XCTAssertNil(store.selectedThreadID)
    failing.withLock { $0 = false }
    let missing = await store.openSearchResult(SearchUnreadFixture.id(2))
    XCTAssertFalse(missing)
    XCTAssertNil(store.list.error)
    XCTAssertNotNil(store.search.openingError)
    XCTAssertNil(store.selectedThreadID)
    failing.withLock { $0 = true }
    let failedAgain = await store.openSearchResult(SearchUnreadFixture.id(2))
    XCTAssertFalse(failedAgain)
    XCTAssertNotNil(store.list.error)
    XCTAssertNil(store.search.openingError)
  }

  func testEmptyDeniedFailedAndRetriedMessageSearch() async throws {
    let attempt = Mutex(0)
    let fixture = ChatHTTPFixture { request in
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
    try await waitForBusinessResult { !search.isLoading }
    XCTAssertTrue(search.messages.isEmpty)
    XCTAssertNil(search.error)
    search.updateQuery("denied")
    try await waitForBusinessResult { !search.isLoading }
    XCTAssertNotNil(search.error)
    XCTAssertTrue(search.messages.isEmpty)
    search.updateQuery("retry")
    try await waitForBusinessResult { !search.isLoading }
    XCTAssertNotNil(search.error)
    search.retry()
    try await waitForBusinessResult { !search.isLoading }
    XCTAssertNil(search.error)
    XCTAssertEqual(search.messages.first?.matchedMessage.content, "Recovered")
  }

  func testUnreadFilterMatchesPWABusyMutedArchivedBoundariesAndBulkReadScope() async throws {
    let fixture = SearchUnreadFixture()
    let store = fixture.workspace()
    defer { store.close() }
    await store.refreshNavigation()
    await store.refresh()
    store.list.onlyUnread = true
    let agent = SearchUnreadFixture.agent
    XCTAssertEqual(
      store.list.threads(agentID: agent, archived: false).map(\.id), [SearchUnreadFixture.id(5)])
    XCTAssertEqual(
      store.list.threads.first { $0.id == SearchUnreadFixture.id(1) }?.indicator, .active)
    XCTAssertTrue(store.list.threads.first { $0.id == SearchUnreadFixture.id(3) }?.isMuted == true)
    await store.list.markAgentRead(agent)
    XCTAssertEqual(fixture.state.value.withLock { $0.bulkAgent }, agent)
    XCTAssertTrue(store.list.threads(agentID: agent, archived: false).isEmpty)
    XCTAssertTrue(store.list.threads.first { $0.id == SearchUnreadFixture.id(2) }?.isUnread == true)
    XCTAssertEqual(
      store.list.threads.first { $0.id == SearchUnreadFixture.id(1) }?.indicator, .active)
  }

  func testBulkReadUsesAgentIndicatorsWhenThreadResultsAreBounded() async throws {
    let fixture = SearchUnreadFixture()
    fixture.state.value.withLock { $0.omitThreadIndicators = true }
    let store = fixture.workspace()
    defer { store.close() }
    await store.refresh()
    XCTAssertTrue(store.list.unreadAgentIDs.contains(SearchUnreadFixture.agent))
    XCTAssertFalse(store.list.threads.contains(where: \.isUnread))
    let thread = try XCTUnwrap(store.list.threads.first { $0.id == SearchUnreadFixture.id(1) })
    await store.setRead(thread, read: true)
    XCTAssertFalse(fixture.state.value.withLock { $0.unread.contains(1) })
    XCTAssertTrue(fixture.state.value.withLock { $0.unread.contains(5) })
    await store.list.markAgentRead(SearchUnreadFixture.agent)
    XCTAssertEqual(fixture.state.value.withLock { $0.bulkAgent }, SearchUnreadFixture.agent)
    XCTAssertFalse(store.list.unreadAgentIDs.contains(SearchUnreadFixture.agent))
    XCTAssertTrue(store.list.unreadAgentIDs.contains(SearchUnreadFixture.otherAgent))
  }
}

@MainActor
private func nativeCollection(_ view: UIView) -> UICollectionView? {
  if let collection = view as? UICollectionView { return collection }
  for child in view.subviews { if let collection = nativeCollection(child) { return collection } }
  return nil
}

private func query(_ request: URLRequest, _ name: String) -> String? {
  request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }?
    .queryItems?.first { $0.name == name }?.value
}

private func searchResponse(content: String) -> ChatHTTPResponse {
  let range = (content as NSString).range(of: "needle")
  let start = range.location == NSNotFound ? 0 : range.location
  let end = range.location == NSNotFound ? min(3, content.utf16.count) : NSMaxRange(range)
  let text = String(decoding: try! JSONEncoder().encode(content), as: UTF8.self)
  return ChatHTTPResponse(
    body: """
      {"results":[{"chatThreadId":"\(SearchUnreadFixture.id(2))","agentName":"Research","matchedMessage":{"chatThreadId":"\(SearchUnreadFixture.id(2))","role":"assistant","content":\(text),"createdAt":"2026-10-19T12:00:00Z","seqId":5,"runId":null},"matchedRanges":[{"start":\(start),"end":\(end)}]}]}
      """)
}

private final class SearchResponseGate: Sendable {
  private let stream: AsyncStream<Void>
  private let continuation: AsyncStream<Void>.Continuation
  init() {
    let pair = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
    stream = pair.stream
    continuation = pair.continuation
  }
  func wait() async { for await _ in stream { break } }
  func open() {
    continuation.yield()
    continuation.finish()
  }
}

private final class SearchUnreadFixture: Sendable {
  static let agent = "61000000-0000-4000-8000-000000000001"
  static let otherAgent = "61000000-0000-4000-8000-000000000002"
  static let timestamp = "2026-10-19T12:00:00Z"
  struct State {
    var unread: Set<Int> = [1, 2, 3, 5]
    var marker = SearchUnreadFixture.timestamp
    var bulkAgent: String?
    var failWrites = false
    var omitThreadIndicators = false
    var dropUnreadResponse = false
    var writes: [String] = []
    var bulkReadGate: SearchResponseGate?
    var bulkReadStarted: (@Sendable () -> Void)?
    var readGate: SearchResponseGate?
    var readStarted: (@Sendable () -> Void)?
  }
  final class LockedState: Sendable { let value = Mutex(State()) }
  let state: LockedState
  let http: ChatHTTPFixture
  init() {
    let state = LockedState()
    self.state = state
    http = ChatHTTPFixture { [state] request in
      let path = request.url?.path ?? ""
      switch path {
      case "/api/agents":
        return ChatHTTPResponse(
          body: """
            [{"agentId":"\(Self.agent)","displayName":"Okou","isDefaultAgent":true},{"agentId":"\(Self.otherAgent)","displayName":"Research","isDefaultAgent":false}]
            """)
      case "/api/user-preferences": return ChatHTTPResponse(body: "{\"pinnedAgentIds\":[]}")
      case "/api/feature-switches":
        return ChatHTTPResponse(
          body:
            "{\"effectiveSwitches\":{\"chatThreadArchiving\":true}}"
        )
      case "/api/chat/search":
        return searchResponse(content: "A matching needle in another agent's conversation")
      case "/api/chat-threads/snapshot":
        let threads = (1...40).map { index in
          """
          {"id":"\(Self.id(index))","agentId":"\(index.isMultiple(of: 2) ? Self.otherAgent : Self.agent)","title":"Chat \(index)","createdAt":"\(Self.timestamp)","updatedAt":"\(Self.timestamp)","sortAt":"\(Self.timestamp)","muted":\(index == 3),"archived":\(index == 5)}
          """
        }.joined(separator: ",")
        return ChatHTTPResponse(
          body: "{\"chatThreads\":[\(threads)],\"latestEventId\":null,\"latestSeqId\":null}")
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
      case "/api/indicators":
        return state.value.withLock { value in
          let indicators = value.unread.filter { $0 != 1 }.sorted().map {
            "\"\(Self.id($0))\":\"unread\""
          }
          let timestamps = value.unread.sorted().map { "\"\(Self.id($0))\":\"\(value.marker)\"" }
            .joined(separator: ",")
          let unreadAgents = Set(
            value.unread.filter { $0 != 3 }.map {
              $0.isMultiple(of: 2) ? Self.otherAgent : Self.agent
            })
          let agents = unreadAgents.sorted().map { "\"\($0)\":\"unread\"" }.joined(separator: ",")
          if value.omitThreadIndicators {
            return ChatHTTPResponse(body: "{\"agents\":{\(agents)},\"threads\":{},\"unreadAt\":{}}")
          }
          return ChatHTTPResponse(
            body:
              "{\"agents\":{\(agents)},\"threads\":{\((["\"\(Self.id(1))\":\"active\""] + indicators).joined(separator: ","))},\"unreadAt\":{\(timestamps)}}"
          )
        }
      case "/api/chat-thread-unreads/mark-read":
        let gate = state.value.withLock { value -> SearchResponseGate? in
          let gate = value.bulkReadGate
          value.bulkReadGate = nil
          value.bulkReadStarted?()
          value.bulkReadStarted = nil
          return gate
        }
        if let gate { await gate.wait() }
        let body = try JSONDecoder().decode([String: String].self, from: chatRequestBody(request))
        return state.value.withLock { value in
          if value.failWrites {
            return ChatHTTPResponse(status: 503, body: "{\"error\":{\"message\":\"Try later\"}}")
          }
          value.bulkAgent = body["agentId"]
          value.unread = value.unread.filter {
            ($0.isMultiple(of: 2) ? Self.otherAgent : Self.agent) != body["agentId"]
          }
          return ChatHTTPResponse(status: 204, body: "")
        }
      default:
        guard path.hasPrefix("/api/chat-threads/") else { throw URLError(.unsupportedURL) }
        let id = String(path.dropFirst("/api/chat-threads/".count).prefix(36))
        let number = Int(id.suffix(12)) ?? 0
        if path.hasSuffix("/mark-read") || path.hasSuffix("/mark-unread") {
          let read = path.hasSuffix("/mark-read")
          let gate = state.value.withLock { value -> SearchResponseGate? in
            guard read else { return nil }
            let gate = value.readGate
            value.readGate = nil
            value.readStarted?()
            value.readStarted = nil
            return gate
          }
          if let gate { await gate.wait() }
          let response = state.value.withLock { value in
            if value.failWrites {
              return ChatHTTPResponse(status: 503, body: "{\"error\":{\"message\":\"Try later\"}}")
            }
            value.writes.append(read ? "read" : "unread")
            if read { value.unread.remove(number) } else { value.unread.insert(number) }
            return ChatHTTPResponse(
              body: "{\"lastReadAt\":\(read ? "\"\(value.marker)\"" : "null")}")
          }
          if !read && state.value.withLock({ $0.dropUnreadResponse }) {
            throw URLError(.networkConnectionLost)
          }
          return response
        }
        if path.hasSuffix("/event-snapshot") {
          return ChatHTTPResponse(
            status: 404,
            body:
              "{\"error\":{\"code\":\"CHAT_EVENT_SNAPSHOT_NOT_FOUND\",\"message\":\"No snapshot\"}}"
          )
        }
        if path.hasSuffix("/event-rows") {
          let after = Int(query(request, "sinceSeqId") ?? "0") ?? 0
          let last = min(161, after + 50)
          let rows =
            after < last
            ? ((after + 1)...last).map { sequence in
              let terminal = sequence == 161
              return """
                {"id":"\(Self.rowID(sequence))","chatThreadId":"\(id)","seqId":\(sequence),"runId":\(terminal ? "\"62000000-0000-4000-8000-999999999999\"" : "null"),"createdAt":"\(Self.timestamp)","eventType":"\(terminal ? "run.completed" : "output.message")","payload":\(terminal ? "null" : "{\"content\":\"History message \(sequence)\"}")}
                """
            }.joined(separator: ",") : ""
          return ChatHTTPResponse(
            body:
              "{\"rows\":[\(rows)],\"cursor\":{\"lastEventId\":\"\(Self.rowID(last))\",\"lastSeqId\":\(last)},\"hasMore\":\(last < 161)}"
          )
        }
        if path == "/api/chat-threads/\(id)" {
          return ChatHTTPResponse(body: "{\"cancellationRecoveryPending\":false}")
        }
        throw URLError(.unsupportedURL)
      }
    }
  }
  @MainActor func workspace() -> WorkspaceStore {
    WorkspaceStore(client: http.client, webURL: http.baseURL)
  }
  static func id(_ index: Int) -> String { String(format: "62000000-0000-4000-8000-%012d", index) }
  static func rowID(_ index: Int) -> String {
    String(format: "63000000-0000-4000-8000-%012d", index)
  }
}
