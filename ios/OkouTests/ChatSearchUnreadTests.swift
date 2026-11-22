import ChatData
import ChatDataTestSupport
import ChatDomain
import Observation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class ChatSearchUnreadTests: XCTestCase {

  func testBulkReadBlocksConcurrentChangesAndRecoversAfterFailure() async throws {
    let fixture = SearchUnreadFixture()
    let store = fixture.workspace()
    defer { store.close() }
    await store.prepareWorkspaceComposer()
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
    let pending = Task { await store.list.markAllRead() }
    await fulfillment(of: [started], timeout: 2)
    XCTAssertTrue(store.list.markingAllRead)
    await store.list.markAllRead()
    await store.setRead(otherThread, read: true)
    gate.open()
    await pending.value
    XCTAssertFalse(store.list.markingAllRead)
    XCTAssertTrue(store.list.updatingThreads.isEmpty)
    XCTAssertNotNil(store.list.error)

    fixture.state.value.withLock { $0.failWrites = false }
    await store.list.markAllRead()
    XCTAssertNil(store.list.error)
    XCTAssertFalse(store.list.markingAllRead)
    XCTAssertTrue(store.list.updatingThreads.isEmpty)
    XCTAssertFalse(store.list.threads.first { $0.id == otherThread.id }?.isUnread == true)
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
    store.setPhase(.active)
    store.selectChat(SearchUnreadFixture.id(1))
    store.sidebarInteraction.setOpen(false)
    let conversation = try XCTUnwrap(store.selectedConversation)
    let refresh = Task { await conversation.refresh() }
    addTeardownBlock {
      refresh.cancel()
      gate.open()
      await refresh.value
    }
    await fulfillment(of: [started], timeout: 3)
    let thread = try XCTUnwrap(store.list.threads.first { $0.id == SearchUnreadFixture.id(1) })
    let menu = ChatThreadMenu(workspace: store, threadID: thread.id, moveToProject: { _ in })
    let manual = Task { await menu.perform(.markUnread) }
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
    try await assertNewDeliveryIsRead(indicatorsFirst: false)
  }

  func testNewServerDeliveryCanBeReadWhenIndicatorsPublishBeforeRecovery() async throws {
    try await assertNewDeliveryIsRead(indicatorsFirst: true)
  }

  func testReadCursorRefreshAwaitsAResidentConversationRefresh() async throws {
    try await assertNewDeliveryIsRead(indicatorsFirst: true, residentRefresh: true)
  }

  func testConcurrentReadReconciliationSharesOneMarkRead() async throws {
    try await assertNewDeliveryIsRead(indicatorsFirst: false, completion: .shared)
  }

  func testBackgroundCancelsReadReconciliationAfterLateIndicators() async throws {
    try await assertNewDeliveryIsRead(indicatorsFirst: false, completion: .background)
  }

  func testFailedAutomaticReadRequiresAnotherRefreshInsteadOfAJoinRetry() async throws {
    let fixture = SearchUnreadFixture()
    let store = fixture.workspace()
    addTeardownBlock { await store.close().value }
    await store.refresh()
    store.setPhase(.active)
    store.selectChat(SearchUnreadFixture.id(1))
    store.sidebarInteraction.setOpen(false)
    let conversation = try XCTUnwrap(store.selectedConversation)
    await conversation.refresh(waitForCurrent: true)
    let thread = try XCTUnwrap(store.list.threads.first { $0.id == SearchUnreadFixture.id(1) })
    await store.setRead(thread, read: false)

    let recoveryStarted = expectation(description: "Recovery waits for the newer indicators")
    let gate = SearchResponseGate()
    defer { gate.open() }
    fixture.state.value.withLock {
      $0.marker = "2026-10-19T12:01:00Z"
      $0.failNextRead = true
      $0.recoveryGate = gate
      $0.recoveryStarted = { recoveryStarted.fulfill() }
    }
    let refresh = Task { await store.refresh([.readCursor]) }
    addTeardownBlock {
      refresh.cancel()
      gate.open()
      await refresh.value
    }
    await fulfillment(of: [recoveryStarted], timeout: 3)
    await store.list.refreshIndicators()
    gate.open()
    await refresh.value
    XCTAssertNotNil(conversation.readSyncError)
    XCTAssertTrue(store.list.threads.first { $0.id == thread.id }?.isUnread == true)
    XCTAssertEqual(fixture.state.value.withLock { $0.writes }, ["read", "unread"])

    await store.refresh([.readCursor])
    XCTAssertNil(conversation.readSyncError)
    XCTAssertFalse(store.list.threads.first { $0.id == thread.id }?.isUnread == true)
    XCTAssertEqual(fixture.state.value.withLock { $0.writes }, ["read", "unread", "read"])
  }

  private enum ReadCompletion: Equatable { case immediate, shared, background }

  private func prepareUnreadDelivery(in store: WorkspaceStore, fixture: SearchUnreadFixture)
    async throws -> (ConversationStore, ChatThread)
  {
    await store.refresh()
    store.setPhase(.active)
    store.selectChat(SearchUnreadFixture.id(1))
    store.sidebarInteraction.setOpen(false)
    let conversation = try XCTUnwrap(store.selectedConversation)
    await conversation.refresh(waitForCurrent: true)
    let thread = try XCTUnwrap(store.list.threads.first { $0.id == SearchUnreadFixture.id(1) })
    await store.setRead(thread, read: false)
    await store.refresh([.readCursor])
    XCTAssertEqual(fixture.state.value.withLock { $0.writes }, ["read", "unread"])
    return (conversation, thread)
  }

  private func assertNewDeliveryIsRead(
    indicatorsFirst: Bool, residentRefresh: Bool = false, completion: ReadCompletion = .immediate
  ) async throws {
    let fixture = SearchUnreadFixture()
    let store = fixture.workspace()
    addTeardownBlock { await store.close().value }
    let (conversation, thread) = try await prepareUnreadDelivery(in: store, fixture: fixture)

    let indicatorsStarted = expectation(description: "New unread indicators reached HTTP")
    let recoveryStarted =
      indicatorsFirst ? expectation(description: "Conversation recovery reached HTTP") : nil
    let readStarted =
      completion == .immediate ? nil : expectation(description: "New mark-read reached HTTP")
    let readCancelled =
      completion == .background ? expectation(description: "Background cancelled mark-read") : nil
    let readFinished =
      completion == .background ? expectation(description: "Retired HTTP handler finished") : nil
    let gate = SearchResponseGate()
    let readGate = SearchResponseGate()
    defer {
      gate.open()
      readGate.open()
    }
    fixture.state.value.withLock {
      $0.marker = "2026-10-19T12:01:00Z"
      $0.indicatorsStarted = { indicatorsStarted.fulfill() }
      if indicatorsFirst {
        $0.recoveryGate = gate
        $0.recoveryStarted = { recoveryStarted?.fulfill() }
      } else {
        $0.indicatorsGate = gate
      }
      if completion != .immediate {
        $0.readGate = readGate
        $0.readStarted = { readStarted?.fulfill() }
        $0.readCancelled = { readCancelled?.fulfill() }
        $0.readFinished = { readFinished?.fulfill() }
      }
    }
    let resident = Task {
      if residentRefresh { await conversation.refresh() }
    }
    addTeardownBlock {
      resident.cancel()
      gate.open()
      await resident.value
    }
    if residentRefresh, let recoveryStarted {
      await fulfillment(of: [recoveryStarted], timeout: 3)
    }
    // Capture the business result at the workspace's own completion boundary, before
    // a resident refresh could conceal an early return by finishing later.
    let refresh = Task {
      await store.refresh([.readCursor])
      return fixture.state.value.withLock { $0.writes }
    }
    addTeardownBlock {
      refresh.cancel()
      gate.open()
      readGate.open()
      _ = await refresh.value
    }
    await fulfillment(of: [indicatorsStarted], timeout: 3)
    if indicatorsFirst {
      if !residentRefresh, let recoveryStarted {
        await fulfillment(of: [recoveryStarted], timeout: 3)
      }
      await store.list.refreshIndicators()
      XCTAssertEqual(
        conversation.thread.unreadAt,
        ISO8601DateFormatter().date(from: "2026-10-19T12:01:00Z"))
    } else {
      // A complete history/recovery operation still sees the manually unread delivery.
      await conversation.refresh(waitForCurrent: true)
      XCTAssertEqual(fixture.state.value.withLock { $0.writes }, ["read", "unread"])
    }
    gate.open()
    if let readStarted {
      await fulfillment(of: [readStarted], timeout: 3)
      if completion == .shared {
        let shared = Task.immediate { await conversation.reconcileReadState() }
        addTeardownBlock {
          shared.cancel()
          readGate.open()
          await shared.value
        }
        readGate.open()
        await shared.value
      } else if let readCancelled, let readFinished {
        store.setPhase(.background)
        await fulfillment(of: [readCancelled], timeout: 3)
        readGate.open()
        await fulfillment(of: [readFinished], timeout: 3)
        _ = await refresh.value
        // Remote acceptance is not cancellation rollback. The retired response
        // must not clear the locally confirmed unread state while backgrounded.
        XCTAssertTrue(store.list.threads.first { $0.id == thread.id }?.isUnread == true)
        store.setPhase(.active)
        await store.list.refreshIndicators()
        await store.refresh([.readCursor])
      }
    }
    let writesAtCompletion = await refresh.value
    if completion != .background {
      XCTAssertEqual(writesAtCompletion, ["read", "unread", "read"])
    }
    await resident.value
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
    store.setPhase(.active)
    store.selectChat(SearchUnreadFixture.id(1))
    store.sidebarInteraction.setOpen(false)
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
      if let empty = emptySearchResources(request) { return empty }
      switch request.url?.path {
      case "/api/chat-threads/snapshot":
        return ChatHTTPResponse(
          body: """
            {"chatThreads":[{"id":"\(SearchUnreadFixture.id(1))","title":"Chat","createdAt":"\(SearchUnreadFixture.timestamp)","updatedAt":"\(SearchUnreadFixture.timestamp)","sortAt":"\(SearchUnreadFixture.timestamp)"}],"latestEventId":null,"latestSeqId":null}
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
          return ChatHTTPResponse(body: "{\"threads\":{},\"unreadAt\":{}}")
        }
        return ChatHTTPResponse(
          body:
            "{\"threads\":{\"\(SearchUnreadFixture.id(1))\":\"unread\"},\"unreadAt\":{\"\(SearchUnreadFixture.id(1))\":\"\(SearchUnreadFixture.timestamp)\"}}"
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
      for await unread in Observations({ store.list.threads.first?.isUnread })
      where unread == false {
        return
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

  func testUnreadFilterMatchesPWABusyMutedArchivedBoundariesAndBulkReadScope() async throws {
    let fixture = SearchUnreadFixture()
    let store = fixture.workspace()
    defer { store.close() }
    await store.prepareWorkspaceComposer()
    await store.refresh()
    store.sidebar.select(.unread)
    let agent = SearchUnreadFixture.agent
    XCTAssertEqual(
      store.list.threads(
        archived: false, onlyUnread: store.sidebar.filter == .unread
      ).map(\.id), [5, 2].map(SearchUnreadFixture.id))
    XCTAssertEqual(
      store.list.threads.first { $0.id == SearchUnreadFixture.id(1) }?.indicator, .active)
    XCTAssertTrue(store.list.threads.first { $0.id == SearchUnreadFixture.id(3) }?.isMuted == true)
    await store.list.markAllRead()
    XCTAssertTrue(
      store.list.threads(
        archived: false, onlyUnread: store.sidebar.filter == .unread
      ).isEmpty)
    XCTAssertFalse(
      store.list.threads.first { $0.id == SearchUnreadFixture.id(2) }?.isUnread == true)
    XCTAssertEqual(
      store.list.threads.first { $0.id == SearchUnreadFixture.id(1) }?.indicator, .active)
  }

  func testBulkReadUsesAgentIndicatorsWhenThreadResultsAreBounded() async throws {
    let fixture = SearchUnreadFixture()
    fixture.state.value.withLock { $0.omitThreadIndicators = true }
    let store = fixture.workspace()
    defer { store.close() }
    await store.refresh()
    XCTAssertFalse(store.list.threads.contains(where: \.isUnread))
    let thread = try XCTUnwrap(store.list.threads.first { $0.id == SearchUnreadFixture.id(1) })
    await store.setRead(thread, read: true)
    XCTAssertFalse(fixture.state.value.withLock { $0.unread.contains(1) })
    XCTAssertTrue(fixture.state.value.withLock { $0.unread.contains(5) })
    await store.list.markAllRead()
  }
}
