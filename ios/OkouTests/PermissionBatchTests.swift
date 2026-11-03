import ChatData
import ChatDataTestSupport
import ChatDomain
import Foundation
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
    let action = try XCTUnwrap(
      ChatPermissionBatchAction(
        value: F.actionURL(), webURL: fixture.http.baseURL, agentID: F.agentID, threadID: F.threadID
      ))
    let card = conversation.permissionActions.card(action)
    await card.refresh()
    return (conversation, card)
  }
}
