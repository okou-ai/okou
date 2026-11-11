import ChatData
import ChatDataTestSupport
import ChatDomain
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class MailDraftCardTests: XCTestCase {
  private func conversation(_ fixture: MailDraftHTTPFixture) -> ConversationStore {
    let sync = ChatSync(client: fixture.http.client)
    let commands = ChatCommands(client: fixture.http.client, sync: sync)
    let thread = ChatThread(
      id: "63000000-0000-4000-8000-000000000002",
      agentID: "63000000-0000-4000-8000-000000000001", title: "Mail review",
      createdAt: .now, updatedAt: .now, sortAt: .now, pinnedAt: nil, pinOrder: nil)
    return ConversationStore(
      thread: thread, sync: sync, commands: commands, webURL: fixture.http.baseURL,
      messageMarkdown: MessageMarkdownCache(baseURL: fixture.http.baseURL),
      isVisible: { true }, didMarkRead: { _ in }, didSend: {}, didFail: { _ in }, didSettle: {})
  }

  private func setup(_ fixture: MailDraftHTTPFixture) -> (ConversationStore, MailDraftCardStore) {
    let conversation = conversation(fixture)
    conversation.approvals.activate()
    return (conversation, conversation.approvals.mailDraft(MailDraftHTTPFixture.id))
  }

  func testRowsShareDraftReadsWithoutSendingAndAReopenedDetailRevalidates() async throws {
    let fixture = MailDraftHTTPFixture()
    let conversation = conversation(fixture)
    defer { conversation.close() }
    let owner = UUID()
    conversation.setDetailVisible(true, owner: owner)
    let card = conversation.approvals.mailDraft(MailDraftHTTPFixture.id.uppercased())
    let original = try await card.read()
    XCTAssertEqual(original?.subject, "Review this email")
    XCTAssertEqual(original?.attachments.first?.filename, "review.txt")
    fixture.state.withLock { $0.subject = "Changed by the provider" }
    let reused = try await conversation.approvals.mailDraft(MailDraftHTTPFixture.id).read()
    XCTAssertEqual(reused?.subject, original?.subject)
    conversation.setDetailVisible(false, owner: owner)
    conversation.setDetailVisible(true, owner: UUID())
    let fresh = try await card.read()
    XCTAssertEqual(fresh?.subject, "Changed by the provider")
    let requests = fixture.state.withLock { $0.requests }
    XCTAssertEqual(requests.filter { $0.url?.path == MailDraftHTTPFixture.path }.count, 2)
    XCTAssertTrue(requests.allSatisfy { $0.httpMethod == "GET" })
    XCTAssertTrue(
      requests.allSatisfy {
        $0.value(forHTTPHeaderField: "Authorization") == "Bearer local-test-session"
      })
  }

  func testCancelledRowWaiterDoesNotCancelTheSharedOriginalHTTP() async throws {
    let began = expectation(description: "Draft HTTP began")
    let gate = ModelResponseGate()
    let fixture = MailDraftHTTPFixture { request, _ in
      if request.url?.path == MailDraftHTTPFixture.path {
        began.fulfill()
        await gate.wait()
        XCTAssertFalse(Task.isCancelled)
      }
    }
    let (conversation, card) = setup(fixture)
    defer { conversation.close() }
    let first = Task { try await card.read() }
    let second = Task { try await conversation.approvals.mailDraft(MailDraftHTTPFixture.id).read() }
    addTeardownBlock { @MainActor in
      first.cancel()
      second.cancel()
      gate.open()
      _ = await first.result
      _ = await second.result
    }
    await fulfillment(of: [began], timeout: 3)
    first.cancel()
    gate.open()
    let sharedStatus = try await second.value?.status
    XCTAssertEqual(sharedStatus, .draft)
    guard case .failure(let error) = await first.result else {
      return XCTFail("A cancelled row cannot publish the shared result")
    }
    XCTAssertTrue(error is CancellationError)
    XCTAssertEqual(fixture.state.withLock { $0.requests.count }, 1)
  }

  func testDeactivateCancelsOriginalHTTPAndRejectsItsLateResponseBeforeReentry() async throws {
    let began = expectation(description: "Original draft HTTP began")
    let cancelled = expectation(description: "Original HTTP was cancelled")
    let gate = ModelResponseGate()
    let reads = Mutex(0)
    let fixture = MailDraftHTTPFixture { request, _ in
      guard request.url?.path == MailDraftHTTPFixture.path else { return }
      let first = reads.withLock { value in
        value += 1
        return value == 1
      }
      if first {
        await withTaskCancellationHandler {
          began.fulfill()
          await gate.wait()
        } onCancel: {
          cancelled.fulfill()
        }
      }
    }
    let (conversation, card) = setup(fixture)
    defer { conversation.close() }
    let pending = Task { try await card.read() }
    addTeardownBlock { @MainActor in
      pending.cancel()
      gate.open()
      _ = await pending.result
    }
    await fulfillment(of: [began], timeout: 3)
    conversation.approvals.deactivate()
    await fulfillment(of: [cancelled], timeout: 3)
    fixture.state.withLock { $0.subject = "Fresh visit" }
    conversation.approvals.activate()
    let fresh = try await card.read()
    XCTAssertEqual(fresh?.subject, "Fresh visit")
    gate.open()
    guard case .failure(let error) = await pending.result else {
      return XCTFail("The retired visit cannot publish its late response")
    }
    XCTAssertTrue(error is CancellationError)
    let currentSubject = try await card.read()?.subject
    XCTAssertEqual(currentSubject, "Fresh visit")
  }

  func testMissingDraftIsUnavailableAndReadRetryNeverWrites() async throws {
    let fixture = MailDraftHTTPFixture()
    fixture.state.withLock { $0.readStatus = 404 }
    let (conversation, card) = setup(fixture)
    defer { conversation.close() }
    let missingDraft = try await card.read()
    XCTAssertNil(missingDraft)
    await card.load()
    await card.send()
    await card.discard()
    fixture.state.withLock { $0.readStatus = 200 }
    let cachedMissing = try await card.read()
    XCTAssertNil(cachedMissing)
    await card.refresh()
    let refreshedStatus = try await card.read()?.status
    XCTAssertEqual(refreshedStatus, .draft)
    XCTAssertTrue(fixture.state.withLock { $0.requests.allSatisfy { $0.httpMethod == "GET" } })
  }

  func testDeniedReadsStayFailuresUntilExplicitRetryAndCannotSendStaleData() async throws {
    for status in [401, 403, 426] {
      let fixture = MailDraftHTTPFixture()
      let (conversation, card) = setup(fixture)
      defer { conversation.close() }
      let initialStatus = try await card.read()?.status
      XCTAssertEqual(initialStatus, .draft)
      fixture.state.withLock { $0.readStatus = status }
      await card.refresh()
      fixture.state.withLock { $0.readStatus = 200 }
      do {
        _ = try await card.read()
        XCTFail("A failed Task stays cached until explicit retry")
      } catch let error as APIClientError { XCTAssertEqual(error.statusCode, status) }
      await card.send()
      XCTAssertTrue(fixture.state.withLock { $0.requests.allSatisfy { $0.httpMethod == "GET" } })
      await card.refresh()
      let retriedStatus = try await card.read()?.status
      XCTAssertEqual(retriedStatus, .draft)
    }
  }

  func testExplicitSendPublishesTheProviderResultAndReadRefreshDoesNotResend() async throws {
    for status in ["sending", "sent", "deleted"] {
      let fixture = MailDraftHTTPFixture()
      fixture.state.withLock {
        $0.sendResult = status
        $0.provider = "outlook"
      }
      let (conversation, card) = setup(fixture)
      defer { conversation.close() }
      await card.send()
      let providerResult = try await card.read()
      let result = try XCTUnwrap(providerResult)
      XCTAssertEqual(result.status.rawValue, status)
      XCTAssertEqual(result.provider, "outlook")
      XCTAssertEqual(result.outlookWebLink?.host, "outlook.office.com")
      await card.send()
      await card.load()
      await card.refresh()
      let refreshedStatus = try await card.read()?.status.rawValue
      XCTAssertEqual(refreshedStatus, status)
      XCTAssertEqual(
        fixture.state.withLock { $0.requests.filter { $0.httpMethod == "POST" }.count }, 1)
    }
  }

  func testReadAndDuplicateSendDuringTheWriteCannotReplaceItsConfirmedResult() async throws {
    let began = expectation(description: "Send accepted by provider")
    let gate = ModelResponseGate()
    let fixture = MailDraftHTTPFixture { request, _ in
      if request.httpMethod == "POST" {
        began.fulfill()
        await gate.wait()
      }
    }
    let (conversation, card) = setup(fixture)
    defer { conversation.close() }
    let initialStatus = try await card.read()?.status
    XCTAssertEqual(initialStatus, .draft)
    let sending = Task { await card.send() }
    addTeardownBlock { @MainActor in
      sending.cancel()
      gate.open()
      await sending.value
    }
    await fulfillment(of: [began], timeout: 3)
    await card.refresh()
    await card.send()
    gate.open()
    await sending.value
    let confirmedStatus = try await card.read()?.status
    XCTAssertEqual(confirmedStatus, .sent)
    XCTAssertEqual(
      fixture.state.withLock { $0.requests.filter { $0.httpMethod == "POST" }.count }, 1)
  }

  func testUncertainSendSurvivesRowReuseAndCachePressureUntilReadOnlyReconciliation()
    async throws
  {
    let fixture = MailDraftHTTPFixture()
    fixture.state.withLock { $0.sendErrorOnce = 503 }
    let (conversation, initial) = setup(fixture)
    defer { conversation.close() }
    await initial.send()
    XCTAssertNotNil(initial.error)
    for _ in 0..<80 { _ = conversation.approvals.mailDraft(UUID().uuidString) }
    let reused = conversation.approvals.mailDraft(MailDraftHTTPFixture.id)
    await reused.load()
    await reused.send()
    XCTAssertTrue(reused.requiresReadback)
    XCTAssertEqual(
      fixture.state.withLock { $0.requests.filter { $0.httpMethod == "POST" }.count }, 1)
    await reused.refresh()
    let reconciledStatus = try await reused.read()?.status
    XCTAssertEqual(reconciledStatus, .sent)
    await reused.send()
    XCTAssertEqual(
      fixture.state.withLock { $0.requests.filter { $0.httpMethod == "POST" }.count }, 1)
  }

  func testLateDraftReadCannotOverwriteAConfirmedSendResponse() async throws {
    let sendBegan = expectation(description: "Send is pending")
    let readBegan = expectation(description: "A concurrent read captured the old draft")
    let readCancelled = expectation(description: "The old original HTTP was cancelled")
    let sendGate = ModelResponseGate()
    let readGate = ModelResponseGate()
    let reads = Mutex(0)
    let fixture = MailDraftHTTPFixture { request, _ in
      if request.httpMethod == "POST" {
        sendBegan.fulfill()
        await sendGate.wait()
      } else if request.httpMethod == "GET" {
        let delayed = reads.withLock { value in
          value += 1
          return value == 2
        }
        if delayed {
          await withTaskCancellationHandler {
            readBegan.fulfill()
            await readGate.wait()
          } onCancel: {
            readCancelled.fulfill()
          }
        }
      }
    }
    let (conversation, card) = setup(fixture)
    defer { conversation.close() }
    let draft = try await card.read()
    XCTAssertEqual(draft?.status, .draft)
    let sending = Task { await card.send() }
    addTeardownBlock { @MainActor in
      sending.cancel()
      sendGate.open()
      readGate.open()
      await sending.value
    }
    await fulfillment(of: [sendBegan], timeout: 3)
    // The external read captured a draft before the provider's Send response arrived.
    fixture.state.withLock { $0.status = "draft" }
    let oldRead = Task { try await card.read(refresh: true) }
    addTeardownBlock { @MainActor in
      oldRead.cancel()
      readGate.open()
      _ = await oldRead.result
    }
    await fulfillment(of: [readBegan], timeout: 3)
    sendGate.open()
    await sending.value
    await fulfillment(of: [readCancelled], timeout: 3)
    readGate.open()
    let latest = try await oldRead.value
    XCTAssertEqual(latest?.status, .sent)
    let confirmed = try await card.read()
    XCTAssertEqual(confirmed?.status, .sent)
  }

  func testReconciliationFetchesHTTPWhileTheConfirmedPresentationTaskIsPending() async throws {
    let fixture = MailDraftHTTPFixture()
    fixture.state.withLock { $0.sendErrorOnce = 503 }
    let (conversation, card) = setup(fixture)
    defer { conversation.close() }
    await card.send()
    // The native loadable starts observing the confirmed baseline without awaiting it.
    let presentation = try card.stateStore.get(card.value)
    addTeardownBlock { @MainActor in
      presentation.cancel()
      _ = await presentation.result
    }
    await card.refresh()
    let reconciled = try await card.read()
    XCTAssertEqual(reconciled?.status, .sent)
    await card.send()
    XCTAssertEqual(
      fixture.state.withLock { $0.requests.filter { $0.httpMethod == "POST" }.count }, 1)
  }

  func testProviderRejectionReconcilesWithGETAndRequiresANewExplicitSend() async throws {
    for status in [400, 409] {
      let fixture = MailDraftHTTPFixture()
      fixture.state.withLock {
        $0.sendErrorOnce = status
        $0.sendResult = status == 400 ? "draft" : "deleted"
      }
      let (conversation, card) = setup(fixture)
      defer { conversation.close() }
      await card.send()
      XCTAssertNotNil(card.error)
      let reconciledStatus = try await card.read()?.status.rawValue
      XCTAssertEqual(reconciledStatus, status == 400 ? "draft" : "deleted")
      XCTAssertEqual(
        fixture.state.withLock { $0.requests.filter { $0.httpMethod == "POST" }.count }, 1)
      if status == 400 {
        fixture.state.withLock { $0.sendResult = "sent" }
        await card.send()
        let sentStatus = try await card.read()?.status
        XCTAssertEqual(sentStatus, .sent)
      }
    }
  }

  func testDiscardReadbackFailureCanOnlyRetryTheRead() async throws {
    let fixture = MailDraftHTTPFixture()
    fixture.state.withLock { $0.readStatusAfterDelete = 503 }
    let (conversation, card) = setup(fixture)
    defer { conversation.close() }
    await card.discard()
    XCTAssertNotNil(card.error)
    await card.discard()
    fixture.state.withLock { $0.readStatus = 200 }
    await card.refresh()
    let discardedStatus = try await card.read()?.status
    XCTAssertEqual(discardedStatus, .deleted)
    await card.discard()
    XCTAssertEqual(
      fixture.state.withLock { $0.requests.filter { $0.httpMethod == "DELETE" }.count }, 1)
  }

  func testReconnectAndEmptyRecipientsRemainReadOnlyUntilTheProviderAllowsSending() async throws {
    for reconnect in [true, false] {
      let fixture = MailDraftHTTPFixture()
      fixture.state.withLock {
        $0.reconnect = reconnect
        $0.emptyRecipients = !reconnect
      }
      let (conversation, card) = setup(fixture)
      defer { conversation.close() }
      await card.send()
      let loadedDraft = try await card.read()
      let draft = try XCTUnwrap(loadedDraft)
      XCTAssertEqual(draft.needsReconnect, reconnect)
      XCTAssertEqual(draft.to.isEmpty, !reconnect)
      XCTAssertTrue(fixture.state.withLock { $0.requests.allSatisfy { $0.httpMethod == "GET" } })
      fixture.state.withLock {
        $0.reconnect = false
        $0.emptyRecipients = false
      }
      await card.refresh()
      await card.send()
      let sentStatus = try await card.read()?.status
      XCTAssertEqual(sentStatus, .sent)
    }
  }

  func testConversationCloseCancelsOriginalSendAndRejectsAllFutureMailWork() async throws {
    let began = expectation(description: "Provider accepted Send")
    let cancelled = expectation(description: "Original Send HTTP cancelled")
    let gate = ModelResponseGate()
    let fixture = MailDraftHTTPFixture { request, _ in
      if request.httpMethod == "POST" {
        await withTaskCancellationHandler {
          began.fulfill()
          await gate.wait()
        } onCancel: {
          cancelled.fulfill()
        }
      }
    }
    let (conversation, card) = setup(fixture)
    let sending = Task { await card.send() }
    addTeardownBlock { @MainActor in
      conversation.close()
      sending.cancel()
      gate.open()
      await sending.value
    }
    await fulfillment(of: [began], timeout: 3)
    conversation.close()
    await fulfillment(of: [cancelled], timeout: 3)
    gate.open()
    await sending.value
    let count = fixture.state.withLock { $0.requests.count }
    for retired in [card, conversation.approvals.mailDraft(MailDraftHTTPFixture.id)] {
      await retired.send()
      await retired.discard()
      do {
        _ = try await retired.read()
        XCTFail("A closed conversation rejects future mail demand")
      } catch { XCTAssertTrue(error is CancellationError) }
    }
    XCTAssertEqual(fixture.state.withLock { $0.requests.count }, count)
    // HTTP cancellation cannot roll back an already accepted provider operation.
    let (reopened, fresh) = setup(fixture)
    defer { reopened.close() }
    let serverStatus = try await fresh.read()?.status
    XCTAssertEqual(serverStatus, .sent)
  }
}

private final class MailDraftHTTPFixture: Sendable {
  static let id = "63000000-0000-4000-8000-0000000000aa"
  static let path = "/api/mail/drafts/\(id)"
  struct State: Sendable {
    var subject = "Review this email"
    var status = "draft"
    var provider = "gmail"
    var readStatus = 200
    var readStatusAfterDelete = 200
    var sendResult = "sent"
    var sendErrorOnce: Int?
    var reconnect = false
    var emptyRecipients = false
    var requests: [URLRequest] = []
  }
  final class ServerState: Sendable {
    private let value = Mutex(State())
    func withLock<T>(_ action: (inout State) throws -> T) rethrows -> T {
      try value.withLock { try action(&$0) }
    }
  }
  let state: ServerState
  let http: ChatHTTPFixture

  init(
    beforeResponse: @escaping @Sendable (URLRequest, ChatHTTPResponse) async -> Void = { _, _ in }
  ) {
    let state = ServerState()
    self.state = state
    http = ChatHTTPFixture { request in
      let response = try state.withLock { value in
        value.requests.append(request)
        if request.httpMethod == "GET", request.url?.path == Self.path {
          return value.readStatus == 200
            ? Self.draft(value) : Self.failure(value.readStatus)
        }
        if request.httpMethod == "POST", request.url?.path == Self.path + "/send" {
          value.status = value.sendResult
          if let status = value.sendErrorOnce {
            value.sendErrorOnce = nil
            return Self.failure(status)
          }
          return Self.draft(value)
        }
        if request.httpMethod == "DELETE", request.url?.path == Self.path {
          value.status = "deleted"
          value.readStatus = value.readStatusAfterDelete
          return ChatHTTPResponse(status: 204, body: "")
        }
        if request.url?.path == "/api/run-models" { return runModelsResponse() }
        throw URLError(.unsupportedURL)
      }
      await beforeResponse(request, response)
      return response
    }
  }

  private static func failure(_ status: Int) -> ChatHTTPResponse {
    ChatHTTPResponse(status: status, body: "{\"error\":{\"message\":\"Mail request failed\"}}")
  }

  private static func draft(_ state: State) -> ChatHTTPResponse {
    let draft: [String: Any] = [
      "version": 3, "provider": state.provider, "from": "sender@example.invalid",
      "to": state.emptyRecipients ? [] : ["recipient@example.invalid"], "cc": [], "bcc": [],
      "subject": state.subject, "body": "An isolated email for review, never sent live.",
      "status": state.status, "detailAvailable": true,
      "accessStatus": state.reconnect ? "reconnect" : "ready",
      "attachments": [["filename": "review.txt", "size": 12]],
      "outlookWebLink": "https://outlook.office.com/mail/deeplink/compose/test-draft",
    ]
    let data = try! JSONSerialization.data(withJSONObject: ["mailDraft": draft])
    return ChatHTTPResponse(body: String(decoding: data, as: UTF8.self))
  }
}
