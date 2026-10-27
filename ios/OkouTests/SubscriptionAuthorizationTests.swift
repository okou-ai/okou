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

  func testReconnectDoesNotUseACachedAccountWhenItsRequiredRefreshFails() async throws {
    let failing = Mutex(false)
    let fixture = ChatHTTPFixture { request in
      if failing.withLock({ $0 }) {
        return ChatHTTPResponse(
          status: 503, body: "{\"error\":{\"message\":\"Accounts unavailable\"}}")
      }
      return try XCTUnwrap(ModelHTTPFixtures.response(request.url!.path))
    }
    let store = PersonalSubscriptionStore(client: fixture.client, didFail: { _ in })
    defer { store.close() }
    await store.refresh()
    XCTAssertEqual(store.accounts.first?.id, ModelHTTPFixtures.accountID)
    failing.withLock { $0 = true }
    let started = await store.reconnect(type: .codex)
    XCTAssertFalse(started)
    XCTAssertNotNil(store.error)
    XCTAssertNil(store.authType)
    XCTAssertEqual(store.phase, .idle)
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
    let scheduled = expectation(description: "Codex poll scheduled")
    let clock = SubscriptionAuthorizationClock(didSchedule: { scheduled.fulfill() })
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
    let store = PersonalSubscriptionStore(
      client: fixture.client, authNow: { clock.now }, authSleep: clock.sleep, didFail: { _ in })
    defer { store.close() }
    store.start(type: .codex)
    try await eventually { store.phase == .pending }
    XCTAssertEqual(store.verificationCode, "EXAMPLE-CODE")
    await fulfillment(of: [scheduled], timeout: 3)
    clock.advance(by: .seconds(1))
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
    let scheduled = expectation(description: "Claude expiry scheduled")
    let clock = SubscriptionAuthorizationClock(didSchedule: { scheduled.fulfill() })
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
    let store = PersonalSubscriptionStore(
      client: fixture.client, authNow: { clock.now }, authSleep: clock.sleep, didFail: { _ in })
    defer {
      store.close()
      completionGate.open()
    }
    store.start(type: .claude)
    try await eventually { store.phase == .pending }
    store.authorizationCode = "example-code"
    let completion = Task { await store.submitClaudeCode() }
    await fulfillment(of: [completing, scheduled], timeout: 3)
    clock.advance(by: .seconds(1))
    await fulfillment(of: [cancelled], timeout: 3)
    completionGate.open()
    await completion.value
    XCTAssertEqual(store.phase, .expired)
    XCTAssertNil(store.browserURL)
    XCTAssertTrue(store.accounts.isEmpty)
  }

  func testExpiredSessionCancelsAndRetainsReconnectTargetForRetry() async throws {
    let scheduled = expectation(description: "Reconnect expiry scheduled")
    let retried = expectation(description: "The reconnect retry has a new pending session")
    let sessions = Mutex<[[String: String]]>([])
    let clock = SubscriptionAuthorizationClock(didSchedule: {
      if sessions.withLock({ $0.count }) == 1 { scheduled.fulfill() } else { retried.fulfill() }
    })
    let expired = expectation(description: "Expired session cancelled")
    let closed = expectation(description: "The retried session is cancelled during cleanup")
    let fixture = ChatHTTPFixture { request in
      if request.url!.path.hasSuffix("/sessions") {
        let body = try authBody(request)
        let count = sessions.withLock {
          $0.append(body)
          return $0.count
        }
        return authSession(code: false, expires: 1, token: "reconnect-session-\(count)")
      }
      if request.url!.path.hasSuffix("/cancel") {
        switch try authBody(request)["sessionToken"] {
        case "reconnect-session-1": expired.fulfill()
        case "reconnect-session-2": closed.fulfill()
        default: XCTFail("Only the two owned reconnect sessions can be cancelled")
        }
        return ChatHTTPResponse(body: "{\"status\":\"cancelled\"}")
      }
      throw URLError(.unsupportedURL)
    }
    let store = PersonalSubscriptionStore(
      client: fixture.client, authNow: { clock.now }, authSleep: clock.sleep, didFail: { _ in })
    defer { store.close() }
    store.start(type: .claude, accountID: ModelHTTPFixtures.accountID)
    await fulfillment(of: [scheduled], timeout: 3)
    clock.advance(by: .seconds(1))
    await fulfillment(of: [expired], timeout: 3)
    XCTAssertEqual(store.phase, .expired)
    XCTAssertNil(store.expiresAt)
    XCTAssertNil(store.browserURL)
    store.retryAuth()
    await fulfillment(of: [retried], timeout: 3)
    XCTAssertEqual(store.phase, .pending)
    let requests = sessions.withLock { $0 }
    XCTAssertEqual(requests.count, 2)
    XCTAssertTrue(requests.allSatisfy { $0["mode"] == "reconnect" })
    XCTAssertTrue(requests.allSatisfy { $0["modelProviderId"] == ModelHTTPFixtures.accountID })
    store.close()
    await fulfillment(of: [closed], timeout: 3)
  }
}

private final class SubscriptionAuthorizationClock: Sendable {
  private struct Sleeper: Sendable {
    let deadline: Date
    let continuation: AsyncStream<Void>.Continuation
  }
  private struct State: Sendable {
    var now = Date(timeIntervalSince1970: 1_800_000_000)
    var sleepers: [UUID: Sleeper] = [:]
  }
  private let state = Mutex(State())
  private let didSchedule: @Sendable () -> Void

  init(didSchedule: @escaping @Sendable () -> Void) {
    self.didSchedule = didSchedule
  }

  var now: Date { state.withLock { $0.now } }

  func sleep(_ duration: Duration) async throws {
    try Task.checkCancellation()
    let id = UUID()
    let tick = AsyncStream<Void>.makeStream()
    state.withLock { value in
      value.sleepers[id] = Sleeper(
        deadline: value.now.addingTimeInterval(seconds(duration)), continuation: tick.continuation)
    }
    defer {
      _ = state.withLock { $0.sleepers.removeValue(forKey: id) }
      tick.continuation.finish()
    }
    didSchedule()
    for await _ in tick.stream {}
    try Task.checkCancellation()
  }

  func advance(by duration: Duration) {
    let ready = state.withLock { value in
      value.now.addTimeInterval(seconds(duration))
      let ready = value.sleepers.filter { $0.value.deadline <= value.now }
      for id in ready.keys { value.sleepers.removeValue(forKey: id) }
      return ready.values.map(\.continuation)
    }
    for continuation in ready { continuation.finish() }
  }

  private func seconds(_ duration: Duration) -> TimeInterval {
    let components = duration.components
    return Double(components.seconds) + Double(components.attoseconds) / 1e18
  }
}

private func authBody(_ request: URLRequest) throws -> [String: String] {
  try XCTUnwrap(JSONSerialization.jsonObject(with: chatRequestBody(request)) as? [String: String])
}
private func authSession(
  code: Bool, expires: Int = 300, token: String = "synthetic-session-token"
) -> ChatHTTPResponse {
  ChatHTTPResponse(
    body:
      "{\"sessionToken\":\"\(token)\",\"browserUrl\":\"https://auth.example.invalid/authorize\",\"expiresIn\":\(expires),\"interval\":1\(code ? ",\"verificationCode\":\"EXAMPLE-CODE\"" : "")}"
  )
}
