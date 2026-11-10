import ChatData
import ChatDataTestSupport
import ChatDomain
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class PermissionActionTests: XCTestCase {

  private func makeConversation(_ fixture: PermissionHTTPFixture) -> ConversationStore {
    let sync = ChatSync(client: fixture.http.client)
    let commands = ChatCommands(client: fixture.http.client, sync: sync)
    let thread = ChatThread(
      id: PermissionHTTPFixture.threadID, agentID: PermissionHTTPFixture.agentID,
      title: "Permissions", createdAt: .now, updatedAt: .now, sortAt: .now, pinnedAt: nil,
      pinOrder: nil)
    return ConversationStore(
      thread: thread, sync: sync, commands: commands,
      webURL: fixture.http.baseURL,
      messageMarkdown: MessageMarkdownCache(baseURL: fixture.http.baseURL),
      isVisible: { true }, didMarkRead: { _ in }, didSend: {}, didFail: { _ in }, didSettle: {})
  }

  func testPermissionReadsAreReusedUntilTheDetailIsReopened() async throws {
    let fixture = PermissionHTTPFixture()
    let conversation = makeConversation(fixture)
    defer { conversation.close() }
    let owner = UUID()
    conversation.setDetailVisible(true, owner: owner)
    let action = try descriptor(fixture)
    let card = conversation.permissionActions.card(action)
    let initial = try await card.resource.load()
    XCTAssertTrue(initial.metadata?.contains(card.action.permission) == true)
    XCTAssertFalse(card.applied(initial))

    fixture.state.withLock { $0.grants = PermissionHTTPFixture.grant() }
    // Reused rows and ordinary history updates retain the current visit's result.
    _ = try await conversation.permissionActions.card(action).resource.load()
    await conversation.refresh()
    let cached = try await card.resource.load()
    XCTAssertFalse(card.applied(cached))

    conversation.setDetailVisible(false, owner: owner)
    conversation.setDetailVisible(true, owner: UUID())
    let revalidated = try await card.resource.load()
    XCTAssertTrue(card.applied(revalidated))
  }

  func testReusingARowDoesNotCancelItsPageOwnedPermissionRead() async throws {
    let gate = ModelResponseGate()
    let started = expectation(description: "Permission read started")
    let fixture = PermissionHTTPFixture { request in
      if request.url!.path == "/api/agents/\(PermissionHTTPFixture.agentID)" {
        started.fulfill()
        await gate.wait()
      }
    }
    let conversation = makeConversation(fixture)
    defer {
      gate.open()
      conversation.close()
    }
    conversation.setDetailVisible(true, owner: UUID())
    let card = conversation.permissionActions.card(try descriptor(fixture))
    let row = Task { try await card.resource.load() }
    await fulfillment(of: [started], timeout: 3)
    row.cancel()
    let reused = Task { try await card.resource.load() }
    gate.open()
    _ = try? await row.value
    _ = try await reused.value
    let snapshot5 = try await card.resource.load()
    XCTAssertTrue(snapshot5.metadata?.contains(card.action.permission) == true)
  }

  func testConfirmRevalidatesTheConversationAfterLoadingTheCard() async throws {
    let fixture = PermissionHTTPFixture()
    let (conversation, card) = try await setup(fixture)
    defer { conversation.close() }
    fixture.state.withLock { $0.threadAgentID = UUID().uuidString }
    await card.confirm()
    XCTAssertNotNil(card.error)
    XCTAssertTrue(fixture.state.withLock { $0.requests.allSatisfy { $0.httpMethod == "GET" } })
    XCTAssertTrue(fixture.state.withLock { $0.events.isEmpty })
  }

  func testClosingDuringAWriteCancelsItWithoutContinuingTheChat() async throws {
    let gate = ModelResponseGate()
    let started = expectation(description: "Permission write started")
    let fixture = PermissionHTTPFixture { request in
      if request.httpMethod == "PUT" {
        started.fulfill()
        await gate.wait()
      }
    }
    let (conversation, card) = try await setup(fixture)
    defer {
      gate.open()
      conversation.close()
    }
    let operation = Task { await card.confirm() }
    await fulfillment(of: [started], timeout: 3)
    let reviewed = try await card.resource.load()
    conversation.close()
    gate.open()
    await operation.value
    // Canceling an HTTP request cannot roll back a write the server already accepted.
    XCTAssertTrue(fixture.state.withLock { $0.events.isEmpty })
    XCTAssertFalse(card.canConfirm(reviewed))
    let (reopened, refreshed) = try await setup(fixture)
    defer { reopened.close() }
    let reopenedSnapshot = try await refreshed.resource.load()
    XCTAssertEqual(
      refreshed.applied(reopenedSnapshot), fixture.state.withLock { $0.grants != "[]" })
    XCTAssertTrue(fixture.state.withLock { $0.events.isEmpty })
  }

  func testExplicitAllowSavesAndContinuesOnceAndRefreshDoesNotRepeatIt() async throws {
    let fixture = PermissionHTTPFixture()
    let (conversation, card) = try await setup(fixture)
    defer { conversation.close() }
    card.duration = .week
    await card.confirm()
    XCTAssertNil(card.error)
    let snapshot6 = try await card.resource.load()
    XCTAssertTrue(card.applied(snapshot6))
    let refreshed = try await ChatPermissions(client: fixture.http.client).load(card.action)
    XCTAssertEqual(refreshed.grants.first?.action, .allow)
    await card.confirm()
    await conversation.refresh()
    let requests = fixture.state.withLock { $0.requests }
    XCTAssertEqual(requests.filter { $0.httpMethod == "PUT" }.count, 1)
    XCTAssertEqual(requests.filter { $0.url!.path == "/api/chat/events" }.count, 1)
    XCTAssertTrue(conversation.messages.contains { $0.text == "Continue after permission" })
    let sent = try XCTUnwrap(requests.first { $0.url!.path == "/api/chat/events" })
    let body = try XCTUnwrap(
      JSONSerialization.jsonObject(with: chatRequestBody(sent)) as? [String: Any])
    XCTAssertEqual(body["cloudBrowserEnabled"] as? Bool, false)
    XCTAssertTrue(body["computerUseHostId"] is NSNull)
  }

  func testUncertainResumeReadsAcceptedEventBeforeExplicitRetry() async throws {
    var state = PermissionHTTPFixture.State()
    state.loseResumeResponseOnce = true
    let fixture = PermissionHTTPFixture(initial: state)
    let (conversation, card) = try await setup(fixture)
    defer { conversation.close() }
    await card.confirm()
    XCTAssertNotNil(card.error)
    XCTAssertTrue(card.needsContinuation)
    await card.confirm()
    XCTAssertNil(card.error)
    XCTAssertFalse(card.needsContinuation)
    XCTAssertTrue(conversation.messages.contains { $0.text == "Continue after permission" })
    XCTAssertEqual(
      fixture.state.withLock { $0.requests.filter { $0.httpMethod == "PUT" }.count }, 1)
    XCTAssertEqual(
      fixture.state.withLock { $0.requests.filter { $0.url!.path == "/api/chat/events" }.count }, 1)
  }

  func testUncertainGrantReadsServerStateAndOnlyContinuesAfterRetry() async throws {
    var state = PermissionHTTPFixture.State()
    state.loseApplyResponseOnce = true
    let fixture = PermissionHTTPFixture(initial: state)
    let (conversation, card) = try await setup(fixture)
    defer { conversation.close() }
    await card.confirm()
    XCTAssertNotNil(card.error)
    let snapshot7 = try await card.resource.load()
    XCTAssertTrue(card.applied(snapshot7))
    XCTAssertTrue(card.needsContinuation)
    XCTAssertTrue(fixture.state.withLock { $0.events.isEmpty })
    await card.confirm()
    XCTAssertNil(card.error)
    XCTAssertTrue(conversation.messages.contains { $0.text == "Continue after permission" })
    XCTAssertEqual(
      fixture.state.withLock { $0.requests.filter { $0.httpMethod == "PUT" }.count }, 1)
  }

  func testUncertainWriteOwnsReadbackWithoutAnyUIWaiter() async throws {
    let gate = ModelResponseGate()
    let readbackStarted = expectation(description: "Uncertain permission write readback started")
    let boundary = Mutex((written: false, blocked: false))
    var state = PermissionHTTPFixture.State()
    state.loseApplyResponseOnce = true
    let fixture = PermissionHTTPFixture(initial: state) { request in
      let blocksReadback = boundary.withLock { state in
        if request.httpMethod == "PUT" { state.written = true }
        if request.url!.path == "/api/user-permission-grants", state.written, !state.blocked {
          state.blocked = true
          return true
        }
        return false
      }
      if blocksReadback {
        readbackStarted.fulfill()
        await gate.wait()
      }
    }
    let (conversation, card) = try await setup(fixture)
    defer {
      gate.open()
      conversation.close()
    }
    let operation = Task { await card.confirm() }
    // No view, subscription or resource waiter starts this read: Confirm owns it.
    await fulfillment(of: [readbackStarted], timeout: 3)
    XCTAssertTrue(fixture.state.withLock { $0.events.isEmpty })
    gate.open()
    await operation.value
    let current = try await card.resource.load()
    XCTAssertTrue(card.applied(current))
    XCTAssertTrue(card.needsContinuation)
    await card.confirm()
    XCTAssertTrue(conversation.messages.contains { $0.text == "Continue after permission" })
    XCTAssertEqual(
      fixture.state.withLock { $0.requests.filter { $0.httpMethod == "PUT" }.count }, 1)
  }

  func testDeniedWriteCanRetryAndClosingPreventsFurtherMutations() async throws {
    var state = PermissionHTTPFixture.State()
    state.failApplyOnce = true
    let fixture = PermissionHTTPFixture(initial: state)
    let (conversation, card) = try await setup(fixture, action: "deny")
    await card.confirm()
    XCTAssertNotNil(card.error)
    let snapshot8 = try await card.resource.load()
    XCTAssertFalse(card.applied(snapshot8))
    await card.confirm()
    XCTAssertNil(card.error)
    let saved = try await ChatPermissions(client: fixture.http.client).load(card.action)
    XCTAssertEqual(saved.grants.first?.action, .deny)
    XCTAssertNil(saved.grants.first?.expiresAt)
    let reviewed = try await card.resource.load()
    conversation.close()
    let requests = fixture.state.withLock { $0.requests.count }
    await card.confirm()
    await card.refresh()
    XCTAssertEqual(fixture.state.withLock { $0.requests.count }, requests)
  }

  func testExistingGrantDefaultsExpiredAndMissingMetadataAreReadOnlyUntilExplicitConfirm()
    async throws
  {
    for variant in 0..<4 {
      var state = PermissionHTTPFixture.State()
      if variant == 0 { state.grants = PermissionHTTPFixture.grant() }
      if variant == 1 { state.defaultPolicy = "allow" }
      if variant == 2 {
        state.grants = PermissionHTTPFixture.grant(expiration: "2020-01-01T00:00:00Z")
      }
      if variant == 3 { state.missingMetadata = true }
      let fixture = PermissionHTTPFixture(initial: state)
      let (conversation, card) = try await setup(fixture)
      defer { conversation.close() }
      await card.refresh()
      let snapshot9 = try await card.resource.load()
      XCTAssertEqual(card.applied(snapshot9), variant < 2)
      XCTAssertEqual(card.canConfirm(snapshot9), variant == 2)
      XCTAssertTrue(fixture.state.withLock { $0.requests.allSatisfy { $0.httpMethod == "GET" } })
    }
  }

  func testNormalizedReadsShareFailuresAndOnlyExplicitRefreshRetries() async throws {
    let fixture = PermissionHTTPFixture()
    let (conversation, card) = try await setup(fixture)
    defer { conversation.close() }
    let other = conversation.permissionActions.card(try descriptor(fixture, action: "deny"))
    fixture.state.withLock { $0.metadataStatus = 403 }
    // Different write intent shares the same previously loaded connector read.
    let cached = try await other.resource.load()
    XCTAssertTrue(cached.metadata?.contains("mail.send") == true)
    await other.refresh()
    for resource in [card.resource, other.resource] {
      do {
        _ = try await resource.load()
        XCTFail("The shared permission failure must remain visible")
      } catch let error as APIClientError {
        XCTAssertEqual(error.statusCode, 403)
      }
    }
    fixture.state.withLock { $0.metadataStatus = 200 }
    do {
      _ = try await card.resource.load()
      XCTFail("Observing a failed read must not retry it")
    } catch let error as APIClientError { XCTAssertEqual(error.statusCode, 403) }
    await card.refresh()
    let restored = try await other.resource.load()
    XCTAssertTrue(restored.metadata?.contains("mail.send") == true)
    XCTAssertTrue(fixture.state.withLock { $0.requests.allSatisfy { $0.httpMethod == "GET" } })
  }

  func testRetiringADetailCancelsOriginalReadAndReentryCannotPublishItsResult() async throws {
    let gate = ModelResponseGate()
    let started = expectation(description: "Original permission HTTP read started")
    let cancelled = expectation(description: "Original permission HTTP read cancelled")
    let fixtureReadStarted = Mutex(false)
    let fixture = PermissionHTTPFixture { request in
      if request.url!.path == "/api/agents/\(PermissionHTTPFixture.agentID)" {
        if !fixtureReadStarted.withLock({ value in
          let previous = value
          value = true
          return previous
        }) {
          started.fulfill()
          await gate.wait()
          if Task.isCancelled { cancelled.fulfill() }
        }
      }
    }
    let conversation = makeConversation(fixture)
    defer {
      gate.open()
      conversation.close()
    }
    let owner = UUID()
    conversation.setDetailVisible(true, owner: owner)
    let card = conversation.permissionActions.card(try descriptor(fixture))
    let original = Task { try await card.resource.load() }
    await fulfillment(of: [started], timeout: 3)
    conversation.setDetailVisible(false, owner: owner)
    await fulfillment(of: [cancelled], timeout: 3)
    do {
      _ = try await original.value
      XCTFail("A retired visit must reject its original result")
    } catch {
      XCTAssertTrue(error is CancellationError || (error as? URLError)?.code == .cancelled)
    }
    // Release the controlled server before acquiring the next visit's read.
    gate.open()
    fixture.state.withLock { $0.grants = PermissionHTTPFixture.grant() }
    conversation.setDetailVisible(true, owner: UUID())
    let current = try await card.resource.load()
    XCTAssertTrue(card.applied(current))
    conversation.close()
    do {
      _ = try await card.resource.load()
      XCTFail("Closing must prevent future reads, even through a retained resource")
    } catch { XCTAssertTrue(error is CancellationError) }
  }

  func testReadInvalidationAndDetailReentryKeepUncertainContinuationIdentity() async throws {
    var state = PermissionHTTPFixture.State()
    state.loseResumeResponseOnce = true
    let fixture = PermissionHTTPFixture(initial: state)
    let (conversation, card) = try await setup(fixture)
    defer { conversation.close() }
    await card.confirm()
    XCTAssertTrue(card.needsContinuation)
    XCTAssertTrue(conversation.permissionActions.isBusy)
    card.resource.invalidate()
    await card.refresh()
    conversation.permissionActions.deactivate()
    conversation.permissionActions.activate(owner: UUID())
    let refreshed = try await card.resource.load()
    XCTAssertTrue(card.applied(refreshed))
    XCTAssertTrue(card.needsContinuation)
    await card.confirm()
    XCTAssertFalse(card.needsContinuation)
    XCTAssertFalse(conversation.permissionActions.isBusy)
    XCTAssertTrue(conversation.messages.contains { $0.text == "Continue after permission" })
    let requests = fixture.state.withLock { $0.requests }
    XCTAssertEqual(requests.filter { $0.httpMethod == "PUT" }.count, 1)
    XCTAssertEqual(requests.filter { $0.url!.path == "/api/chat/events" }.count, 1)
  }

  private func setup(
    _ fixture: PermissionHTTPFixture, action: String = "allow", callback: Bool = true
  ) async throws
    -> (ConversationStore, PermissionActionStore)
  {
    let conversation = makeConversation(fixture)
    await conversation.refresh()
    conversation.setDetailVisible(true, owner: UUID())
    let card = conversation.permissionActions.card(
      try descriptor(fixture, action: action, callback: callback))
    await card.refresh()
    XCTAssertNil(card.error)
    return (conversation, card)
  }

  private func descriptor(
    _ fixture: PermissionHTTPFixture, action: String = "allow", callback: Bool = true
  ) throws -> ChatPermissionAction {
    let url = try XCTUnwrap(
      URL(
        string: PermissionHTTPFixture.actionURL(action: action, callback: callback),
        relativeTo: fixture.http.baseURL)
    )
    return try XCTUnwrap(
      ChatPermissionAction(
        url: url, agentID: PermissionHTTPFixture.agentID, threadID: PermissionHTTPFixture.threadID))
  }

}
