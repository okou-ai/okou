import ChatData
import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class SubscriptionAuthorizationTests: XCTestCase {
  func testUsageResetRetriesOneIdempotencyKeyAfterAnUncertainResponse() async throws {
    let keys = Mutex<[String]>([])
    let fixture = ChatHTTPFixture { request in
      if request.url!.path.hasSuffix("subscription-reset") {
        let key = try XCTUnwrap(authBody(request)["idempotencyKey"])
        let count = keys.withLock {
          $0.append(key)
          return $0.count
        }
        return count == 1
          ? ChatHTTPResponse(status: 503, body: "{\"error\":{\"message\":\"Connection lost\"}}")
          : ChatHTTPResponse(body: "{\"outcome\":\"alreadyRedeemed\"}")
      }
      return try XCTUnwrap(ModelHTTPFixtures.response(request.url!.path))
    }
    let store = PersonalSubscriptionStore(client: fixture.client, didFail: { _ in })
    defer { store.close() }
    await store.refresh()
    let account = try XCTUnwrap(store.accounts.first)
    await store.reset(account)
    XCTAssertNotNil(store.error)
    await store.reset(account)
    XCTAssertNil(store.error)
    XCTAssertEqual(keys.withLock { $0.count }, 2)
    XCTAssertEqual(Set(keys.withLock { $0 }).count, 1)
  }

  func testConnectionRefreshesModelsBeforeQuotaAndSurvivesAuthorizationDismissal() async throws {
    let quotaGate = ModelResponseGate()
    let quotaStarted = expectation(description: "Quota is still loading after model refresh")
    let linked = Mutex(false)
    let fixture = ChatHTTPFixture { request in
      let path = request.url!.path
      if path.hasSuffix("/sessions") { return authSession(code: false) }
      if path.hasSuffix("/complete") {
        linked.withLock { $0 = true }
        return ChatHTTPResponse(body: "{\"status\":\"complete\"}")
      }
      if path == "/api/me/3rd-party-subscriptions" {
        quotaStarted.fulfill()
        await quotaGate.wait()
        return ChatHTTPResponse(body: ModelHTTPFixtures.subscriptions)
      }
      var response = try XCTUnwrap(ModelHTTPFixtures.response(path))
      if path == "/api/user-model-preference", linked.withLock({ $0 }) {
        response.body = response.body.replacingOccurrences(
          of: "\"selectedModel\":\"codex-model\"", with: "\"selectedModel\":\"claude-model\"")
      }
      return response
    }
    let resource = ChatModelStore(
      client: fixture.client, webURL: fixture.baseURL, didFail: { _ in })
    defer {
      quotaGate.open()
      resource.close()
    }
    await resource.refresh()
    let store = resource.subscriptions
    store.start(type: .claude)
    try await eventually { store.phase == .pending }
    store.authorizationCode = "example-code"
    let completion = Task { await store.submitClaudeCode() }
    await fulfillment(of: [quotaStarted], timeout: 3)
    XCTAssertEqual(resource.configuration?.defaultSelection.model, "claude-model")
    XCTAssertTrue(store.accounts.isEmpty)
    store.cancelAuth()
    completion.cancel()
    quotaGate.open()
    await completion.value
    XCTAssertEqual(store.phase, .idle)
    XCTAssertEqual(store.accounts.first?.id, ModelHTTPFixtures.accountID)
    XCTAssertEqual(store.authorizationCode, "")
  }

  func testCodexPollsWithSessionTokenAndRefreshesAfterSuccess() async throws {
    let completed = expectation(description: "Codex token completion")
    let fixture = ChatHTTPFixture { request in
      let path = request.url!.path
      if path.hasSuffix("/sessions") { return authSession(code: true) }
      if path.hasSuffix("/complete") {
        XCTAssertEqual(try authBody(request)["sessionToken"], "synthetic-session-token")
        XCTAssertNil(try authBody(request)["authorizationCode"])
        completed.fulfill()
        return ChatHTTPResponse(body: "{\"status\":\"complete\"}")
      }
      return try XCTUnwrap(ModelHTTPFixtures.response(path))
    }
    let store = PersonalSubscriptionStore(client: fixture.client, didFail: { _ in })
    defer { store.close() }
    store.start(type: .codex)
    try await eventually { store.phase == .pending }
    XCTAssertEqual(store.verificationCode, "EXAMPLE-CODE")
    await fulfillment(of: [completed], timeout: 3)
    try await eventually { store.phase == .complete && !store.accounts.isEmpty }
    XCTAssertNil(store.browserURL)
    XCTAssertNil(store.verificationCode)
    XCTAssertEqual(store.authorizationCode, "")
  }

  func testClaudeRequiresCodeAndKeepsReconnectAccountIdentity() async throws {
    let started = Mutex<[String: String]>([:])
    let submitted = Mutex<[String: String]>([:])
    let fixture = ChatHTTPFixture { request in
      if request.url!.path.hasSuffix("/sessions") {
        started.withLock { $0 = (try? authBody(request)) ?? [:] }
        return authSession(code: false)
      }
      if request.url!.path.hasSuffix("/complete") {
        submitted.withLock { $0 = (try? authBody(request)) ?? [:] }
        return ChatHTTPResponse(body: "{\"status\":\"complete\"}")
      }
      return try XCTUnwrap(ModelHTTPFixtures.response(request.url!.path))
    }
    let store = PersonalSubscriptionStore(client: fixture.client, didFail: { _ in })
    defer { store.close() }
    store.start(type: .claude, accountID: ModelHTTPFixtures.accountID)
    try await eventually { store.phase == .pending }
    XCTAssertNil(store.verificationCode)
    await store.submitClaudeCode()
    XCTAssertTrue(submitted.withLock { $0.isEmpty })
    store.authorizationCode = " example-authorization-code "
    await store.submitClaudeCode()
    XCTAssertEqual(store.phase, .complete)
    XCTAssertEqual(started.withLock { $0["mode"] }, "reconnect")
    XCTAssertEqual(started.withLock { $0["modelProviderId"] }, ModelHTTPFixtures.accountID)
    XCTAssertEqual(submitted.withLock { $0["authorizationCode"] }, "example-authorization-code")
    XCTAssertEqual(store.authorizationCode, "")
  }

  func testClosingDuringStartCancelsLateSessionWithoutPublishingIt() async throws {
    let gate = ModelResponseGate()
    let began = expectation(description: "Authorization start")
    let cancelled = expectation(description: "Late session cancelled")
    let fixture = ChatHTTPFixture { request in
      if request.url!.path.hasSuffix("/sessions") {
        began.fulfill()
        await gate.wait()
        return authSession(code: true)
      }
      if request.url!.path.hasSuffix("/cancel") {
        XCTAssertEqual(try authBody(request)["sessionToken"], "synthetic-session-token")
        cancelled.fulfill()
        return ChatHTTPResponse(body: "{\"status\":\"cancelled\"}")
      }
      throw URLError(.unsupportedURL)
    }
    let store = PersonalSubscriptionStore(client: fixture.client, didFail: { _ in })
    store.start(type: .codex)
    await fulfillment(of: [began], timeout: 3)
    store.close()
    gate.open()
    await fulfillment(of: [cancelled], timeout: 3)
    XCTAssertEqual(store.phase, .idle)
    XCTAssertNil(store.browserURL)
    XCTAssertNil(store.authType)
    XCTAssertTrue(store.accounts.isEmpty)
  }

  func testFailedClaudeCodeCanRetryAndCancelClearsAllTransientState() async throws {
    let cancelled = expectation(description: "Cancel pending Claude session")
    let fixture = ChatHTTPFixture { request in
      if request.url!.path.hasSuffix("/sessions") { return authSession(code: false) }
      if request.url!.path.hasSuffix("/complete") {
        return ChatHTTPResponse(status: 400, body: "{\"error\":{\"message\":\"Invalid code\"}}")
      }
      if request.url!.path.hasSuffix("/cancel") {
        cancelled.fulfill()
        return ChatHTTPResponse(body: "{\"status\":\"cancelled\"}")
      }
      throw URLError(.unsupportedURL)
    }
    let store = PersonalSubscriptionStore(client: fixture.client, didFail: { _ in })
    store.start(type: .claude)
    try await eventually { store.phase == .pending }
    store.authorizationCode = "invalid-example"
    await store.submitClaudeCode()
    XCTAssertEqual(store.phase, .pending)
    XCTAssertNotNil(store.authError)
    XCTAssertEqual(store.authorizationCode, "")
    store.cancelAuth()
    await fulfillment(of: [cancelled], timeout: 3)
    XCTAssertEqual(store.phase, .idle)
    XCTAssertNil(store.authError)
    XCTAssertNil(store.expiresAt)
    store.close()
  }

  func testLateClaudeCompletionCannotOverrideExpiry() async throws {
    let completionGate = ModelResponseGate()
    let completing = expectation(description: "Claude completion in flight")
    let cancelled = expectation(description: "Expired session cancelled")
    let fixture = ChatHTTPFixture { request in
      if request.url!.path.hasSuffix("/sessions") { return authSession(code: false, expires: 1) }
      if request.url!.path.hasSuffix("/complete") {
        completing.fulfill()
        await completionGate.wait()
        return ChatHTTPResponse(body: "{\"status\":\"complete\"}")
      }
      if request.url!.path.hasSuffix("/cancel") {
        cancelled.fulfill()
        return ChatHTTPResponse(body: "{\"status\":\"cancelled\"}")
      }
      throw URLError(.unsupportedURL)
    }
    let store = PersonalSubscriptionStore(client: fixture.client, didFail: { _ in })
    defer {
      store.close()
      completionGate.open()
    }
    store.start(type: .claude)
    try await eventually { store.phase == .pending }
    store.authorizationCode = "example-code"
    let completion = Task { await store.submitClaudeCode() }
    await fulfillment(of: [completing, cancelled], timeout: 3)
    completionGate.open()
    await completion.value
    XCTAssertEqual(store.phase, .expired)
    XCTAssertNil(store.browserURL)
    XCTAssertTrue(store.accounts.isEmpty)
  }

  func testExpiredSessionCancelsAndRetainsReconnectTargetForRetry() async throws {
    let expired = expectation(description: "Expired session cancelled")
    let fixture = ChatHTTPFixture { request in
      if request.url!.path.hasSuffix("/sessions") { return authSession(code: false, expires: 1) }
      if request.url!.path.hasSuffix("/cancel") {
        expired.fulfill()
        return ChatHTTPResponse(body: "{\"status\":\"cancelled\"}")
      }
      throw URLError(.unsupportedURL)
    }
    let store = PersonalSubscriptionStore(client: fixture.client, didFail: { _ in })
    defer { store.close() }
    store.start(type: .claude, accountID: ModelHTTPFixtures.accountID)
    await fulfillment(of: [expired], timeout: 3)
    XCTAssertEqual(store.phase, .expired)
    XCTAssertNil(store.expiresAt)
    XCTAssertNil(store.browserURL)
  }
}

private func authBody(_ request: URLRequest) throws -> [String: String] {
  try XCTUnwrap(JSONSerialization.jsonObject(with: chatRequestBody(request)) as? [String: String])
}
private func authSession(code: Bool, expires: Int = 300) -> ChatHTTPResponse {
  ChatHTTPResponse(
    body:
      "{\"sessionToken\":\"synthetic-session-token\",\"browserUrl\":\"https://auth.example.invalid/authorize\",\"expiresIn\":\(expires),\"interval\":1\(code ? ",\"verificationCode\":\"EXAMPLE-CODE\"" : "")}"
  )
}
