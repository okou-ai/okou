import ChatData
import ChatDataTestSupport
import ChatDomain
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
    conversation.close()
    gate.open()
    await operation.value
    // Canceling an HTTP request cannot roll back a write the server already accepted.
    XCTAssertTrue(fixture.state.withLock { $0.events.isEmpty })
    XCTAssertFalse(card.canConfirm)
    let (reopened, refreshed) = try await setup(fixture)
    defer { reopened.close() }
    XCTAssertEqual(refreshed.applied, fixture.state.withLock { $0.grants != "[]" })
    XCTAssertTrue(fixture.state.withLock { $0.events.isEmpty })
  }

  func testExplicitAllowSavesAndContinuesOnceAndRefreshDoesNotRepeatIt() async throws {
    let fixture = PermissionHTTPFixture()
    let (conversation, card) = try await setup(fixture)
    defer { conversation.close() }
    card.duration = .week
    await card.confirm()
    XCTAssertNil(card.error)
    XCTAssertTrue(card.applied)
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
    XCTAssertTrue(card.applied)
    XCTAssertTrue(card.needsContinuation)
    XCTAssertTrue(fixture.state.withLock { $0.events.isEmpty })
    await card.confirm()
    XCTAssertNil(card.error)
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
    XCTAssertFalse(card.applied)
    await card.confirm()
    XCTAssertNil(card.error)
    let saved = try await ChatPermissions(client: fixture.http.client).load(card.action)
    XCTAssertEqual(saved.grants.first?.action, .deny)
    XCTAssertNil(saved.grants.first?.expiresAt)
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
      XCTAssertEqual(card.applied, variant < 2)
      XCTAssertEqual(card.canConfirm, variant == 2)
      XCTAssertTrue(fixture.state.withLock { $0.requests.allSatisfy { $0.httpMethod == "GET" } })
    }
  }

  private func setup(
    _ fixture: PermissionHTTPFixture, action: String = "allow", callback: Bool = true
  ) async throws
    -> (ConversationStore, PermissionActionStore)
  {
    let conversation = makeConversation(fixture)
    let thread = conversation.thread
    await conversation.refresh()
    let url = try XCTUnwrap(
      URL(
        string: PermissionHTTPFixture.actionURL(action: action, callback: callback),
        relativeTo: fixture.http.baseURL)
    )
    let descriptor = try XCTUnwrap(
      ChatPermissionAction(url: url, agentID: thread.agentID, threadID: thread.id))
    let card = conversation.permissionActions.card(descriptor)
    await card.refresh()
    XCTAssertNil(card.error)
    return (conversation, card)
  }
}
