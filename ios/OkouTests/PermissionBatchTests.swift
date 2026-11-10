import ChatData
import ChatDataTestSupport
import ChatDomain
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class PermissionBatchTests: XCTestCase {
  private typealias F = PermissionBatchHTTPFixture

  func testTranscriptRecognizesBatchActionsWithoutPromotingCodeOrForeignLinks() async throws {
    let webURL = URL(string: "https://app.okou.ai")!
    let markdown = MessageMarkdownCache(baseURL: webURL)
    defer { markdown.clear() }
    let link = F.actionURL()
    let fence = String(repeating: "\u{60}", count: 3)
    let source = """
      [Review permissions](\(link))

      \(fence)
      \(link)
      \(fence)

      [Untrusted](https://evil.invalid\(link))
      """
    let content = await markdown.content(for: source)
    let blocks = MessageActionBody.blocks(
      content, webURL: webURL, agentID: F.agentID, threadID: F.threadID)
    let actions = blocks.compactMap { block -> ChatPermissionBatchAction? in
      if case .permissionBatch(let action) = block { return action }
      return nil
    }
    XCTAssertEqual(actions.count, 1)
    let action = try XCTUnwrap(actions.first)
    XCTAssertEqual(action.callbackPrompt, "Continue after permissions")
    XCTAssertEqual(action.items.count, 4)
  }

  func testConfirmSavesMissingGrantsAndContinuesOnce() async throws {
    let fixture = fixture()
    let (conversation, card) = try await setup(fixture)
    defer { conversation.close() }
    card.duration = .week
    try await confirm(card)
    XCTAssertNil(card.error)
    let snapshot1 = try await card.resource.load()
    XCTAssertTrue(snapshot1.allAllowed)
    XCTAssertTrue(conversation.messages.contains { $0.text == "Continue after permissions" })
    try await confirm(card)
    await card.refresh()
    let saved = try await ChatBatchPermissions(client: fixture.http.client).load(card.action)
    XCTAssertTrue(saved.allAllowed)
    let requests = fixture.state.withLock { $0.requests }
    XCTAssertEqual(requests.filter { $0.httpMethod == "PUT" }.count, 1)
    XCTAssertEqual(requests.filter { $0.url!.path == "/api/chat/events" }.count, 1)
  }

  func testPartialSharedSaveReadsBackAndOnlyRetriesMissingConnector() async throws {
    var state = F.State()
    state.shared = true
    state.failConnector = "google-drive"
    let fixture = fixture(state)
    let (conversation, card) = try await setup(fixture)
    defer { conversation.close() }
    try await confirm(card)
    XCTAssertNotNil(card.error)
    let snapshot2 = try await card.resource.load()
    XCTAssertEqual(snapshot2.allowedCount, 2)
    XCTAssertTrue(fixture.state.withLock { $0.events.isEmpty })
    fixture.state.withLock { $0.failConnector = nil }
    try await confirm(card)
    XCTAssertNil(card.error)
    let snapshot3 = try await card.resource.load()
    XCTAssertTrue(snapshot3.allAllowed)
    let writes = fixture.state.withLock { $0.requests.filter { $0.httpMethod == "PUT" } }
    let targets = try writes.map { request in
      let body = try JSONSerialization.jsonObject(with: chatRequestBody(request)) as! [String: Any]
      return (body["target"] as! [String: String])["connectorSlug"]!
    }
    XCTAssertEqual(targets, ["gmail", "google-drive", "google-drive"])
    XCTAssertTrue(conversation.messages.contains { $0.text == "Continue after permissions" })
  }

  func testLostWriteResponseDoesNotAutomaticallyContinueOrRepeatGrant() async throws {
    var state = F.State()
    state.loseBatchResponseOnce = true
    let fixture = fixture(state)
    let (conversation, card) = try await setup(fixture)
    defer { conversation.close() }
    try await confirm(card)
    let snapshot4 = try await card.resource.load()
    XCTAssertTrue(snapshot4.allAllowed)
    let snapshot5 = try await card.resource.load()
    XCTAssertTrue(card.needsContinuation(snapshot5))
    XCTAssertTrue(fixture.state.withLock { $0.events.isEmpty })
    try await confirm(card)
    XCTAssertNil(card.error)
    XCTAssertTrue(conversation.messages.contains { $0.text == "Continue after permissions" })
    XCTAssertEqual(
      fixture.state.withLock { $0.requests.filter { $0.httpMethod == "PUT" }.count }, 1)
  }

  func testUnconfirmedWriteRequiresSuccessfulReadBeforeExplicitRetry() async throws {
    var state = F.State()
    state.loseBatchResponseOnce = true
    state.failReadbackAfterWrite = true
    let fixture = fixture(state)
    let (conversation, card) = try await setup(fixture)
    defer { conversation.close() }
    let reviewed = try await card.resource.load()
    try await confirm(card)
    XCTAssertTrue(card.requiresReadback)
    XCTAssertFalse(card.canConfirm(reviewed))
    await card.confirm(reviewed)
    XCTAssertEqual(
      fixture.state.withLock { $0.requests.filter { $0.httpMethod == "PUT" }.count }, 1)
    XCTAssertTrue(fixture.state.withLock { $0.events.isEmpty })
    fixture.state.withLock { $0.grantReadStatus = 200 }
    await card.refresh()
    try await confirm(card)
    XCTAssertTrue(conversation.messages.contains { $0.text == "Continue after permissions" })
    XCTAssertEqual(
      fixture.state.withLock { $0.requests.filter { $0.httpMethod == "PUT" }.count }, 1)
  }

  func testContinueAfterRevocationRequiresAnotherExplicitGrantConfirmation() async throws {
    var state = F.State()
    state.loseBatchResponseOnce = true
    let fixture = fixture(state)
    let (conversation, card) = try await setup(fixture)
    defer { conversation.close() }
    try await confirm(card)
    let snapshot6 = try await card.resource.load()
    XCTAssertTrue(card.needsContinuation(snapshot6))
    fixture.state.withLock { $0.grants.removeAll { $0.permission == "mail.send" } }
    await card.refresh()
    await card.confirm(snapshot6)
    XCTAssertNotNil(card.error)
    let snapshot7 = try await card.resource.load()
    XCTAssertFalse(snapshot7.allAllowed)
    XCTAssertTrue(fixture.state.withLock { $0.events.isEmpty })
    XCTAssertEqual(
      fixture.state.withLock { $0.requests.filter { $0.httpMethod == "PUT" }.count }, 1)
    // The next confirmation now approves the missing permission, not a continuation.
    try await confirm(card)
    XCTAssertTrue(conversation.messages.contains { $0.text == "Continue after permissions" })
    XCTAssertEqual(
      fixture.state.withLock { $0.requests.filter { $0.httpMethod == "PUT" }.count }, 2)
  }

  func testLostContinuationReceiptReadsEventBeforeRetryingAndDoesNotRegrant() async throws {
    var state = F.State()
    state.loseResumeResponseOnce = true
    let fixture = fixture(state)
    let (conversation, card) = try await setup(fixture)
    defer { conversation.close() }
    try await confirm(card)
    let snapshot8 = try await card.resource.load()
    XCTAssertTrue(card.needsContinuation(snapshot8))
    try await confirm(card)
    XCTAssertNil(card.error)
    let snapshot9 = try await card.resource.load()
    XCTAssertFalse(card.needsContinuation(snapshot9))
    XCTAssertTrue(conversation.messages.contains { $0.text == "Continue after permissions" })
    let requests = fixture.state.withLock { $0.requests }
    XCTAssertEqual(requests.filter { $0.httpMethod == "PUT" }.count, 1)
    XCTAssertEqual(requests.filter { $0.url!.path == "/api/chat/events" }.count, 1)
  }

  func testReopeningRetainsDurationButRechecksRevokedGrantsAndNewContext() async throws {
    let fixture = fixture()
    let (conversation, card) = try await setup(fixture)
    defer { conversation.close() }
    card.duration = .day
    try await confirm(card)
    fixture.state.withLock {
      $0.grants.removeAll { $0.permission == "mail.send" }
      $0.threadAgentID = UUID().uuidString
    }
    await card.refresh()
    let snapshot10 = try await card.resource.load()
    XCTAssertFalse(snapshot10.allAllowed)
    XCTAssertEqual(card.duration, .day)
    let writes = fixture.state.withLock { $0.requests.filter { $0.httpMethod == "PUT" }.count }
    try await confirm(card)
    XCTAssertNotNil(card.error)
    XCTAssertEqual(
      fixture.state.withLock { $0.requests.filter { $0.httpMethod == "PUT" }.count }, writes)
    let reviewed = try await card.resource.load()
    conversation.close()
    await card.refresh()
    XCTAssertFalse(card.canConfirm(reviewed))
  }

  func testConfirmKeepsTheReviewedScopeWhenAnotherReaderRefreshes() async throws {
    let fixture = fixture()
    let (conversation, card) = try await setup(fixture)
    defer { conversation.close() }
    let reviewed = try await card.resource.load()
    XCTAssertFalse(reviewed.connectorScoped)
    // A shared reader may publish a newer scope after the user has reviewed the request.
    fixture.state.withLock { $0.shared = true }
    await card.refresh()
    let updated = try await card.resource.load()
    XCTAssertTrue(updated.connectorScoped)
    await card.confirm(reviewed)
    XCTAssertNotNil(card.error)
    XCTAssertTrue(
      fixture.state.withLock {
        $0.requests.allSatisfy {
          $0.httpMethod != "PUT" && $0.url!.path != "/api/chat/events"
        }
      })
    XCTAssertTrue(fixture.state.withLock { $0.events.isEmpty })
  }

  func testAlreadyAllowedRequestOnlyContinuesOnExplicitConfirmation() async throws {
    var state = F.State()
    state.grants = F.items.map {
      F.Grant(connectorSlug: $0["connectorSlug"]!, permission: $0["permission"]!)
    }
    let fixture = fixture(state)
    let (conversation, card) = try await setup(fixture)
    defer { conversation.close() }
    let snapshot11 = try await card.resource.load()
    XCTAssertTrue(snapshot11.allAllowed)
    XCTAssertTrue(fixture.state.withLock { $0.events.isEmpty })
    try await confirm(card)
    XCTAssertTrue(conversation.messages.contains { $0.text == "Continue after permissions" })
    XCTAssertTrue(fixture.state.withLock { $0.requests.allSatisfy { $0.httpMethod != "PUT" } })
  }

  func testClosingConversationDuringWriteCannotContinueOrWriteAgain() async throws {
    let gate = ModelResponseGate()
    let started = expectation(description: "Batch write started")
    let fixture = F(
      onUnhandledRequest: { XCTFail($0) },
      beforeRequest: { request in
        if request.httpMethod == "PUT" {
          started.fulfill()
          await gate.wait()
        }
      })
    let (conversation, card) = try await setup(fixture)
    defer {
      gate.open()
      conversation.close()
    }
    let operation = Task { try await confirm(card) }
    await fulfillment(of: [started], timeout: 3)
    let reviewed = try await card.resource.load()
    conversation.close()
    gate.open()
    try await operation.value
    XCTAssertTrue(fixture.state.withLock { $0.events.isEmpty })
    XCTAssertFalse(card.canConfirm(reviewed))
    let count = fixture.state.withLock { $0.requests.count }
    await card.confirm(reviewed)
    await card.refresh()
    XCTAssertEqual(fixture.state.withLock { $0.requests.count }, count)
  }

  func testReusedBatchWaiterAndReentryHaveDifferentReadLifetimes() async throws {
    let gate = ModelResponseGate()
    let started = expectation(description: "Batch HTTP read started")
    let cancelled = expectation(description: "Batch HTTP read cancelled")
    let first = Mutex(true)
    let fixture = F(
      onUnhandledRequest: { XCTFail($0) },
      beforeRequest: { request in
        if request.url!.path == "/api/feature-switches",
          first.withLock({ value in
            let previous = value
            value = false
            return previous
          })
        {
          started.fulfill()
          await gate.wait()
          if Task.isCancelled { cancelled.fulfill() }
        }
      })
    let (conversation, card) = try makeConversation(fixture)
    defer {
      gate.open()
      conversation.close()
    }
    let row = Task { try await card.resource.load() }
    await fulfillment(of: [started], timeout: 3)
    row.cancel()
    // A second row must still be waiting on the original HTTP read, not its cancellation.
    let replacement = Task { try await card.resource.load() }
    conversation.permissionActions.deactivate()
    await fulfillment(of: [cancelled], timeout: 3)
    for waiter in [row, replacement] {
      do {
        _ = try await waiter.value
        XCTFail("A retired visit must reject the shared result")
      } catch {
        XCTAssertTrue(error is CancellationError || (error as? URLError)?.code == .cancelled)
      }
    }
    fixture.state.withLock {
      $0.grants = F.items.map {
        F.Grant(connectorSlug: $0["connectorSlug"]!, permission: $0["permission"]!)
      }
    }
    gate.open()
    conversation.permissionActions.activate(owner: UUID())
    let current = try await card.resource.load()
    XCTAssertTrue(current.allAllowed)
    XCTAssertTrue(fixture.state.withLock { $0.events.isEmpty })
  }

  func testNormalizedBatchReadAndExplicitRetryNeverRepeatPartialWrites() async throws {
    var state = F.State()
    state.shared = true
    state.failConnector = "google-drive"
    let fixture = fixture(state)
    let (conversation, card) = try await setup(fixture)
    defer { conversation.close() }
    let otherAction = try XCTUnwrap(
      ChatPermissionBatchAction(
        value: F.actionURL(items: Array(F.items.reversed()), callback: false, duration: "7d"),
        webURL: fixture.http.baseURL, agentID: F.agentID, threadID: F.threadID))
    let other = conversation.permissionActions.card(otherAction)
    fixture.state.withLock { $0.grantReadStatus = 401 }
    let cached = try await other.resource.load()
    XCTAssertTrue(cached.complete)
    await other.refresh()
    do {
      _ = try await card.resource.load()
      XCTFail("Both cards must observe the shared auth failure")
    } catch let error as APIClientError { XCTAssertEqual(error.statusCode, 401) }
    fixture.state.withLock { $0.grantReadStatus = 200 }
    await card.refresh()
    try await confirm(card)
    let partial = try await other.resource.load()
    XCTAssertEqual(partial.allowedCount, 2)
    XCTAssertTrue(conversation.permissionActions.isBusy)
    await card.refresh()
    conversation.permissionActions.deactivate()
    conversation.permissionActions.activate(owner: UUID())
    await card.refresh()
    XCTAssertTrue(fixture.state.withLock { $0.events.isEmpty })
    fixture.state.withLock { $0.failConnector = nil }
    try await confirm(card)
    let current = try await other.resource.load()
    XCTAssertTrue(current.allAllowed)
    let writes = fixture.state.withLock { $0.requests.filter { $0.httpMethod == "PUT" } }
    let targets = try writes.map { request in
      let body = try JSONSerialization.jsonObject(with: chatRequestBody(request)) as! [String: Any]
      return (body["target"] as! [String: String])["connectorSlug"]!
    }
    XCTAssertEqual(targets, ["gmail", "google-drive", "google-drive"])
    XCTAssertTrue(conversation.messages.contains { $0.text == "Continue after permissions" })
  }

  private func fixture(_ state: F.State = .init()) -> F {
    F(initial: state, onUnhandledRequest: { XCTFail($0) })
  }

  private func confirm(_ card: PermissionBatchStore) async throws {
    let reviewed = try await card.resource.load()
    await card.confirm(reviewed)
  }

  private func setup(_ fixture: F) async throws -> (ConversationStore, PermissionBatchStore) {
    let (conversation, card) = try makeConversation(fixture)
    await card.refresh()
    return (conversation, card)
  }

  private func makeConversation(_ fixture: F) throws -> (ConversationStore, PermissionBatchStore) {
    let sync = ChatSync(client: fixture.http.client)
    let commands = ChatCommands(client: fixture.http.client, sync: sync)
    let thread = ChatThread(
      id: F.threadID, agentID: F.agentID, title: "Batch permissions", createdAt: .now,
      updatedAt: .now, sortAt: .now, pinnedAt: nil, pinOrder: nil)
    let conversation = ConversationStore(
      thread: thread, sync: sync, commands: commands, webURL: fixture.http.baseURL,
      messageMarkdown: MessageMarkdownCache(baseURL: fixture.http.baseURL),
      isVisible: { true }, didMarkRead: { _ in }, didSend: {}, didFail: { _ in }, didSettle: {})
    let action = try XCTUnwrap(
      ChatPermissionBatchAction(
        value: F.actionURL(), webURL: fixture.http.baseURL, agentID: F.agentID, threadID: F.threadID
      ))
    conversation.setDetailVisible(true, owner: UUID())
    let card = conversation.permissionActions.card(action)
    return (conversation, card)
  }
}
