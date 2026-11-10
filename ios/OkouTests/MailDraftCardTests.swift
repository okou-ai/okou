import ChatData
import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class MailDraftCardTests: XCTestCase {
  func testRowReuseSharesTheReadWithoutSendingOrDiscarding() async throws {
    let entered = expectation(description: "Draft HTTP read started")
    let gate = ModelResponseGate()
    let fixture = MailCardHTTPFixture { _ in
      entered.fulfill()
      await gate.wait()
      return MailCardHTTPFixture.draft()
    }
    let registry = ApprovalCardRegistry(
      client: fixture.http.client, didFail: { _ in }, didContinue: {})
    let card = registry.mailDraft("draft")
    let first = Task { try await card.stateStore.get(card.value).value }
    addTeardownBlock { @MainActor in
      gate.open()
      registry.closeMailDrafts()
      first.cancel()
      _ = await first.result
      fixture.http.session.invalidateAndCancel()
    }
    await fulfillment(of: [entered], timeout: 3)
    first.cancel()
    let reused = registry.mailDraft("draft")
    let shared = try reused.stateStore.get(reused.value)
    gate.open()
    let draft = try await shared.value
    XCTAssertEqual(draft?.subject, "Fixture email")
    _ = await first.result
    let remounted = try await registry.mailDraft("draft").stateStore.get(card.value).value
    XCTAssertEqual(remounted, draft)
    XCTAssertTrue(fixture.requests.withLock { $0.allSatisfy { $0.httpMethod == "GET" } })
  }

  func testFailureIsCachedUntilExplicitRetryAndMissingDraftRemainsUnavailable() async throws {
    let response = Mutex(
      ChatHTTPResponse(status: 503, body: #"{"error":{"message":"Provider offline"}}"#))
    let fixture = MailCardHTTPFixture { request in
      if request.url?.lastPathComponent == "missing" {
        return ChatHTTPResponse(status: 404, body: #"{"error":{"message":"Draft not found"}}"#)
      }
      return response.withLock { $0 }
    }
    let registry = ApprovalCardRegistry(
      client: fixture.http.client, didFail: { _ in }, didContinue: {})
    defer { registry.closeMailDrafts() }
    let card = registry.mailDraft("draft")
    let failure = await (try card.stateStore.get(card.value)).result
    assertHTTPStatus(failure, 503)
    response.withLock { $0 = MailCardHTTPFixture.draft() }
    assertHTTPStatus(await (try card.stateStore.get(card.value)).result, 503)
    let missing = registry.mailDraft("missing")
    let unavailable = try await missing.stateStore.get(missing.value).value
    XCTAssertNil(unavailable)
    card.retry()
    let recovered = try await card.stateStore.get(card.value).value
    XCTAssertEqual(recovered?.status, .draft)
    let stillMissing = try await missing.stateStore.get(missing.value).value
    XCTAssertNil(stillMissing)
    XCTAssertTrue(fixture.requests.withLock { $0.allSatisfy { $0.httpMethod == "GET" } })
  }

  func testSupersededReadCannotReplaceTheConfirmedSend() async throws {
    let entered = expectation(description: "Old draft HTTP read started")
    let cancelled = expectation(description: "Original read HTTP cancelled")
    let gate = ModelResponseGate()
    let initial = Mutex(true)
    let fixture = MailCardHTTPFixture { request in
      if request.httpMethod == "POST" { return MailCardHTTPFixture.draft(status: "sent") }
      let holds = initial.withLock { value in
        let first = value
        value = false
        return first
      }
      if holds {
        await withTaskCancellationHandler {
          entered.fulfill()
          await gate.wait()
        } onCancel: {
          cancelled.fulfill()
        }
      }
      return MailCardHTTPFixture.draft()
    }
    let card = fixture.card()
    let original = try card.stateStore.get(card.value)
    addTeardownBlock { @MainActor in
      gate.open()
      card.close()
      _ = await original.result
    }
    await fulfillment(of: [entered], timeout: 3)
    card.retry()
    await fulfillment(of: [cancelled], timeout: 3)
    let current = try await card.stateStore.get(card.value).value
    XCTAssertEqual(current?.status, .draft)
    await card.send()
    gate.open()
    let retired = await original.result
    XCTAssertThrowsError(try retired.get())
    let sent = try await card.stateStore.get(card.value).value
    XCTAssertEqual(sent?.status, .sent)
    XCTAssertNil(card.mutationError)
  }

  func testConfirmedDiscardPublishesUnavailableWithoutReloadingTheOldDraft() async throws {
    let fixture = MailCardHTTPFixture { request in
      switch request.httpMethod {
      case "DELETE": return ChatHTTPResponse(status: 204, body: "")
      case "GET": return MailCardHTTPFixture.draft()
      default: throw URLError(.unsupportedURL)
      }
    }
    let card = fixture.card()
    defer { card.close() }
    _ = try await card.stateStore.get(card.value).value
    await card.discard()
    let discarded = try await card.stateStore.get(card.value).value
    XCTAssertNil(discarded)
    XCTAssertNil(card.mutationError)
    // A reused row cannot rediscover the provider's stale pre-delete draft.
    await card.discard()
    let remounted = try await card.stateStore.get(card.value).value
    XCTAssertNil(remounted)
  }

  func testAmbiguousSendIsReadBackAndNeverAutomaticallyReplayed() async throws {
    let sent = Mutex(false)
    let fixture = MailCardHTTPFixture { request in
      if request.httpMethod == "POST" {
        let duplicate = sent.withLock { value in
          let previous = value
          value = true
          return previous
        }
        XCTAssertFalse(duplicate, "An uncertain write must not be replayed")
        throw URLError(.networkConnectionLost)
      }
      return MailCardHTTPFixture.draft(status: sent.withLock { $0 } ? "sent" : "draft")
    }
    let card = fixture.card()
    defer { card.close() }
    _ = try await card.stateStore.get(card.value).value
    await card.send()
    XCTAssertNotNil(card.mutationError)
    let reconciled = try await card.stateStore.get(card.value).value
    XCTAssertEqual(reconciled?.status, .sent)
    card.retry()
    _ = try await card.stateStore.get(card.value).value
    await card.send()
    let current = try await card.stateStore.get(card.value).value
    XCTAssertEqual(current?.status, .sent)
  }

  func testProviderRejectionKeepsItsMessageAndRefreshesTheDraft() async throws {
    for status in [400, 409] {
      let rejected = Mutex(false)
      let fixture = MailCardHTTPFixture { request in
        if request.httpMethod == "POST" {
          rejected.withLock { $0 = true }
          return ChatHTTPResponse(status: status, body: #"{"error":{"message":"Rejected"}}"#)
        }
        return MailCardHTTPFixture.draft(status: rejected.withLock { $0 } ? "deleted" : "draft")
      }
      let card = fixture.card()
      defer { card.close() }
      _ = try await card.stateStore.get(card.value).value
      await card.send()
      let current = try await card.stateStore.get(card.value).value
      XCTAssertEqual(current?.status, .deleted)
      XCTAssertEqual(
        card.mutationError,
        status == 400
          ? String(localized: "The mail provider rejected this email. Check the recipients.")
          : String(localized: "This draft can no longer be sent."))
    }
  }

  func testAccessErrorsRemainErrorsAndUpgradeCannotBeRetriedAway() async throws {
    for status in [401, 403, 426] {
      let response = Mutex(
        ChatHTTPResponse(status: status, body: #"{"error":{"message":"Access blocked"}}"#))
      var reported: Int?
      let fixture = MailCardHTTPFixture { _ in response.withLock { $0 } }
      let card = fixture.card { reported = ($0 as? APIClientError)?.statusCode }
      defer { card.close() }
      assertHTTPStatus(await (try card.stateStore.get(card.value)).result, status)
      XCTAssertEqual(reported, status)
      response.withLock { $0 = MailCardHTTPFixture.draft() }
      card.retry()
      let result = await (try card.stateStore.get(card.value)).result
      if status == 426 {
        assertHTTPStatus(result, 426)
        await card.send()
        await card.discard()
        XCTAssertTrue(fixture.requests.withLock { $0.allSatisfy { $0.httpMethod == "GET" } })
      } else {
        XCTAssertEqual(try result.get()?.status, .draft)
      }
    }
  }

  func testConversationCloseCancelsOriginalMailIOAndFencesRetainedAndFutureCards() async throws {
    let entered = expectation(description: "Conversation mail HTTP read started")
    let cancelled = expectation(description: "Conversation mail HTTP cancelled")
    let gate = ModelResponseGate()
    let fixture = ConversationHistoryFixture(
      count: 0,
      additional: { request in
        guard request.url?.path == "/api/mail/drafts/draft" else { throw URLError(.unsupportedURL) }
        await withTaskCancellationHandler {
          entered.fulfill()
          await gate.wait()
        } onCancel: {
          cancelled.fulfill()
        }
        return MailCardHTTPFixture.draft()
      })
    let conversation = fixture.conversation()
    let card = conversation.approvals.mailDraft("draft")
    let original = try card.stateStore.get(card.value)
    addTeardownBlock { @MainActor in
      gate.open()
      conversation.close()
      _ = await original.result
    }
    await fulfillment(of: [entered], timeout: 3)
    conversation.close()
    await fulfillment(of: [cancelled], timeout: 3)
    gate.open()
    XCTAssertThrowsError(try card.stateStore.get(card.value))
    let future = conversation.approvals.mailDraft("another-draft")
    XCTAssertThrowsError(try future.stateStore.get(future.value))
    card.retry()
    await card.send()
    await future.discard()
    let result = await original.result
    XCTAssertThrowsError(try result.get())
  }

  func testRegistryRetirementCancelsTheConfirmedMutationIO() async throws {
    let entered = expectation(description: "Send HTTP started")
    let cancelled = expectation(description: "Original send HTTP cancelled")
    let gate = ModelResponseGate()
    let fixture = MailCardHTTPFixture { request in
      if request.httpMethod == "POST" {
        await withTaskCancellationHandler {
          entered.fulfill()
          await gate.wait()
        } onCancel: {
          cancelled.fulfill()
        }
        return MailCardHTTPFixture.draft(status: "sent")
      }
      return MailCardHTTPFixture.draft()
    }
    let registry = ApprovalCardRegistry(
      client: fixture.http.client, didFail: { _ in }, didContinue: {})
    let card = registry.mailDraft("draft")
    _ = try await card.stateStore.get(card.value).value
    let send = Task { await card.send() }
    addTeardownBlock { @MainActor in
      gate.open()
      registry.closeMailDrafts()
      send.cancel()
      await send.value
    }
    await fulfillment(of: [entered], timeout: 3)
    registry.closeMailDrafts()
    await fulfillment(of: [cancelled], timeout: 3)
    gate.open()
    await send.value
    XCTAssertThrowsError(try card.stateStore.get(card.value))
    XCTAssertNil(card.mutationError)
  }

  private func assertHTTPStatus(
    _ result: Result<ChatMailDraft?, Error>, _ status: Int,
    file: StaticString = #filePath, line: UInt = #line
  ) {
    XCTAssertThrowsError(try result.get(), file: file, line: line) {
      XCTAssertEqual(($0 as? APIClientError)?.statusCode, status, file: file, line: line)
    }
  }
}

private final class MailCardHTTPFixture: Sendable {
  let http: ChatHTTPFixture
  let requests = Mutex<[URLRequest]>([])

  init(handler: @escaping ChatHTTPFixture.Handler) {
    let requests = requests
    http = ChatHTTPFixture { request in
      guard request.url?.path.hasPrefix("/api/mail/drafts/") == true else {
        throw URLError(.unsupportedURL)
      }
      requests.withLock { $0.append(request) }
      return try await handler(request)
    }
  }

  @MainActor
  func card(didFail: @escaping @MainActor (Error) -> Void = { _ in }) -> MailDraftCardStore {
    MailDraftCardStore(id: "draft", client: http.client, didFail: didFail)
  }

  static func draft(status: String = "draft") -> ChatHTTPResponse {
    ChatHTTPResponse(
      body: """
        {"mailDraft":{"provider":"gmail","from":"sender@example.invalid","fromName":null,
        "to":["recipient@example.invalid"],"cc":[],"bcc":[],"subject":"Fixture email",
        "body":"This isolated fixture never sends a real email.","status":"\(status)",
        "detailAvailable":true,"accessStatus":null,"attachments":[],"outlookWebLink":null,
        "gmailThreadId":null}}
        """)
  }
}
