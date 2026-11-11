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
    await card.confirm()
    XCTAssertNil(card.error)
    XCTAssertTrue(card.allAllowed)
    XCTAssertTrue(conversation.messages.contains { $0.text == "Continue after permissions" })
    await card.confirm()
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
    await card.confirm()
    XCTAssertNotNil(card.error)
    XCTAssertEqual(card.snapshot?.allowedCount, 2)
    XCTAssertTrue(fixture.state.withLock { $0.events.isEmpty })
    fixture.state.withLock { $0.failConnector = nil }
    await card.confirm()
    XCTAssertNil(card.error)
    XCTAssertTrue(card.allAllowed)
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
    await card.confirm()
    XCTAssertTrue(card.allAllowed)
    XCTAssertTrue(card.needsContinuation)
    XCTAssertTrue(fixture.state.withLock { $0.events.isEmpty })
    await card.confirm()
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
    await card.confirm()
    XCTAssertTrue(card.requiresReadback)
    XCTAssertFalse(card.canConfirm)
    await card.confirm()
    XCTAssertEqual(
      fixture.state.withLock { $0.requests.filter { $0.httpMethod == "PUT" }.count }, 1)
    XCTAssertTrue(fixture.state.withLock { $0.events.isEmpty })
    fixture.state.withLock { $0.grantReadStatus = 200 }
    await card.refresh()
    await card.confirm()
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
    await card.confirm()
    XCTAssertTrue(card.needsContinuation)
    fixture.state.withLock { $0.grants.removeAll { $0.permission == "mail.send" } }
    await card.confirm()
    XCTAssertNotNil(card.error)
    XCTAssertFalse(card.allAllowed)
    XCTAssertTrue(fixture.state.withLock { $0.events.isEmpty })
    XCTAssertEqual(
      fixture.state.withLock { $0.requests.filter { $0.httpMethod == "PUT" }.count }, 1)
    // The next confirmation now approves the missing permission, not a continuation.
    await card.confirm()
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
    await card.confirm()
    XCTAssertTrue(card.needsContinuation)
    let owner = UUID()
    conversation.permissionActions.activate(owner: owner)
    conversation.permissionActions.deactivate()
    for _ in 0..<80 {
      let action = try XCTUnwrap(
        ChatPermissionBatchAction(
          value: F.actionURL(callback: false), webURL: fixture.http.baseURL, agentID: F.agentID,
          threadID: UUID().uuidString))
      _ = conversation.permissionActions.resources.read(action)
    }
    conversation.permissionActions.activate(owner: UUID())
    await card.loadIfNeeded()
    await card.confirm()
    XCTAssertNil(card.error)
    XCTAssertFalse(card.needsContinuation)
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
    await card.confirm()
    fixture.state.withLock {
      $0.grants.removeAll { $0.permission == "mail.send" }
      $0.threadAgentID = UUID().uuidString
    }
    await card.refresh()
    XCTAssertFalse(card.allAllowed)
    XCTAssertEqual(card.duration, .day)
    let writes = fixture.state.withLock { $0.requests.filter { $0.httpMethod == "PUT" }.count }
    await card.confirm()
    XCTAssertNotNil(card.error)
    XCTAssertEqual(
      fixture.state.withLock { $0.requests.filter { $0.httpMethod == "PUT" }.count }, writes)
    conversation.close()
    await card.refresh()
    XCTAssertFalse(card.canConfirm)
  }

  func testAlreadyAllowedRequestOnlyContinuesOnExplicitConfirmation() async throws {
    var state = F.State()
    state.grants = F.items.map {
      F.Grant(connectorSlug: $0["connectorSlug"]!, permission: $0["permission"]!)
    }
    let fixture = fixture(state)
    let (conversation, card) = try await setup(fixture)
    defer { conversation.close() }
    XCTAssertTrue(card.allAllowed)
    XCTAssertTrue(fixture.state.withLock { $0.events.isEmpty })
    await card.confirm()
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
    let operation = Task { await card.confirm() }
    await fulfillment(of: [started], timeout: 3)
    conversation.close()
    gate.open()
    await operation.value
    XCTAssertTrue(fixture.state.withLock { $0.events.isEmpty })
    XCTAssertFalse(card.canConfirm)
    let count = fixture.state.withLock { $0.requests.count }
    await card.confirm()
    await card.refresh()
    XCTAssertEqual(fixture.state.withLock { $0.requests.count }, count)
  }

  func testConfirmUsesTheDisplayedSharedScopeAfterAnotherBatchCardRefreshes() async throws {
    let fixture = fixture()
    let (conversation, card) = try await setup(fixture)
    defer { conversation.close() }
    let action = try XCTUnwrap(
      ChatPermissionBatchAction(
        value: F.actionURL(callback: false, duration: "24h"), webURL: fixture.http.baseURL,
        agentID: F.agentID, threadID: F.threadID))
    fixture.state.withLock { $0.shared = true }
    await conversation.permissionActions.card(action).refresh()
    let displayed = try await card.read.load()
    XCTAssertTrue(displayed.connectorScoped)
    XCTAssertTrue(card.canConfirm(reviewing: displayed))
    await card.confirm(reviewing: displayed)
    XCTAssertNil(card.error)
    let saved = try await ChatBatchPermissions(client: fixture.http.client).load(card.action)
    XCTAssertTrue(saved.allAllowed)
    XCTAssertTrue(conversation.messages.contains { $0.text == "Continue after permissions" })
    let writes = fixture.state.withLock { $0.requests.filter { $0.httpMethod == "PUT" } }
    XCTAssertEqual(writes.count, 2)
    XCTAssertTrue(writes.allSatisfy { $0.url!.path == "/api/connector-permissions" })
  }

  func testEquivalentBatchReadsSurviveOneCancelledWaiterAndKeepSeparateDuration() async throws {
    let blocks = Mutex(false)
    let began = expectation(description: "Shared batch grant HTTP began")
    let gate = ModelResponseGate()
    let fixture = F(
      onUnhandledRequest: { XCTFail($0) },
      beforeRequest: { request in
        if request.url!.path == "/api/user-permission-grants", blocks.withLock({ $0 }) {
          began.fulfill()
          await gate.wait()
        }
      })
    let (conversation, card) = try await setup(fixture)
    let action = try XCTUnwrap(
      ChatPermissionBatchAction(
        value: F.actionURL(items: Array(F.items.reversed()), callback: false, duration: "24h"),
        webURL: fixture.http.baseURL, agentID: F.agentID, threadID: F.threadID))
    let other = conversation.permissionActions.card(action)
    blocks.withLock { $0 = true }
    let one = Task { await card.refresh() }
    await fulfillment(of: [began], timeout: 3)
    let two = Task { await other.loadIfNeeded() }
    addTeardownBlock { @MainActor in
      conversation.close()
      one.cancel()
      two.cancel()
      gate.open()
      await one.value
      await two.value
    }
    one.cancel()
    gate.open()
    await one.value
    await two.value
    XCTAssertTrue(other.canConfirm)
    XCTAssertEqual(other.snapshot?.allowedCount, 0)
    XCTAssertEqual(card.duration, .hour)
    XCTAssertEqual(other.duration, .day)
    XCTAssertEqual(
      fixture.state.withLock {
        $0.requests.filter { $0.url!.path == "/api/user-permission-grants" }.count
      }, 2)
    XCTAssertTrue(fixture.state.withLock { $0.requests.allSatisfy { $0.httpMethod == "GET" } })
  }

  func testRetiringBatchDetailCancelsOriginalReadAndRevalidatesOnReentry() async throws {
    let blocks = Mutex(false)
    let began = expectation(description: "Batch HTTP began")
    let cancelled = expectation(description: "Original batch HTTP cancelled")
    let gate = ModelResponseGate()
    let fixture = F(
      onUnhandledRequest: { XCTFail($0) },
      beforeRequest: { request in
        if request.url!.path == "/api/user-permission-grants", blocks.withLock({ $0 }) {
          await withTaskCancellationHandler {
            began.fulfill()
            await gate.wait()
          } onCancel: {
            cancelled.fulfill()
          }
        }
      })
    let (conversation, card) = try await setup(fixture)
    let owner = UUID()
    conversation.setDetailVisible(true, owner: owner)
    card.duration = .week
    blocks.withLock { $0 = true }
    let pending = Task { await card.refresh() }
    addTeardownBlock { @MainActor in
      conversation.close()
      pending.cancel()
      gate.open()
      await pending.value
    }
    await fulfillment(of: [began], timeout: 3)
    conversation.setDetailVisible(false, owner: owner)
    await fulfillment(of: [cancelled], timeout: 3)
    await card.refresh()
    XCTAssertFalse(card.canConfirm)
    blocks.withLock { $0 = false }
    fixture.state.withLock {
      $0.grants = F.items.map {
        F.Grant(connectorSlug: $0["connectorSlug"]!, permission: $0["permission"]!)
      }
    }
    conversation.setDetailVisible(true, owner: UUID())
    await card.loadIfNeeded()
    XCTAssertTrue(card.allAllowed)
    XCTAssertEqual(card.duration, .week)
    gate.open()
    await pending.value
    XCTAssertTrue(card.allAllowed)
    conversation.close()
    await card.refresh()
    XCTAssertFalse(card.canConfirm)
    XCTAssertTrue(fixture.state.withLock { $0.events.isEmpty })
  }

  func testDeniedBatchReadRequiresExplicitReadbackAndCannotReplayWrites() async throws {
    for status in [401, 403, 426] {
      let fixture = fixture()
      let (conversation, card) = try await setup(fixture)
      defer { conversation.close() }
      fixture.state.withLock { $0.grantReadStatus = status }
      await card.refresh()
      XCTAssertTrue(card.requiresReadback)
      XCTAssertFalse(card.canConfirm)
      fixture.state.withLock { $0.grantReadStatus = 200 }
      await card.loadIfNeeded()
      await card.confirm()
      XCTAssertTrue(card.requiresReadback)
      XCTAssertFalse(card.canConfirm)
      await card.refresh()
      XCTAssertFalse(card.requiresReadback)
      XCTAssertTrue(card.canConfirm)
      XCTAssertTrue(fixture.state.withLock { $0.requests.allSatisfy { $0.httpMethod == "GET" } })
      XCTAssertTrue(fixture.state.withLock { $0.events.isEmpty })
    }
  }

  private func fixture(_ state: F.State = .init()) -> F {
    F(initial: state, onUnhandledRequest: { XCTFail($0) })
  }

  private func setup(_ fixture: F) async throws -> (ConversationStore, PermissionBatchStore) {
    let sync = ChatSync(client: fixture.http.client)
    let commands = ChatCommands(client: fixture.http.client, sync: sync)
    let thread = ChatThread(
      id: F.threadID, agentID: F.agentID, title: "Batch permissions", createdAt: .now,
      updatedAt: .now, sortAt: .now, pinnedAt: nil, pinOrder: nil)
    let conversation = ConversationStore(
      thread: thread, sync: sync, commands: commands, webURL: fixture.http.baseURL,
      messageMarkdown: MessageMarkdownCache(baseURL: fixture.http.baseURL),
      isVisible: { true }, didMarkRead: { _ in }, didSend: {}, didFail: { _ in }, didSettle: {})
    // Exercise the production permission scope without starting unrelated chat summary demand.
    conversation.permissionActions.activate(owner: UUID())
    let action = try XCTUnwrap(
      ChatPermissionBatchAction(
        value: F.actionURL(), webURL: fixture.http.baseURL, agentID: F.agentID, threadID: F.threadID
      ))
    let card = conversation.permissionActions.card(action)
    await card.refresh()
    return (conversation, card)
  }
}
