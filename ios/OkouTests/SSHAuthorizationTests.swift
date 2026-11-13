import ChatData
import ChatDataTestSupport
import ChatDomain
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class SSHAuthorizationTests: XCTestCase {
  func testApprovalContinuesOnTheServerAndRevocationClosesOnlyThisHost() async throws {
    let fixture = SSHAuthorizationFixture()
    let card = try fixture.card()
    card.activate()
    defer { card.close() }
    await card.decide(.approve)
    await card.decide(.approve)
    fixture.state.withLock { $0.expired = true }
    await card.refresh()
    let approved = try await card.read()
    XCTAssertEqual(approved.effectiveStatus(at: .now), .approved)
    XCTAssertEqual(approved.status, .approved)
    XCTAssertFalse(approved.continuationPending)
    XCTAssertEqual(approved.target, "staging@mac.example.com:22")
    XCTAssertEqual(fixture.state.withLock { $0.grants }, 1)
    XCTAssertEqual(fixture.state.withLock { $0.continuations }, 1)
    await card.decide(.revoke)
    let revoked = try await card.read()
    XCTAssertEqual(revoked.status, .revoked)
    XCTAssertFalse(revoked.enabled)
  }

  func testContinuationFailurePreservesTheGrantAndExplicitRetryUsesTheSameRequest() async throws {
    let fixture = SSHAuthorizationFixture()
    fixture.state.withLock { $0.failContinuation = true }
    let card = try fixture.card()
    card.activate()
    defer { card.close() }
    await card.decide(.approve)
    let granted = try await card.read()
    XCTAssertEqual(granted.status, .approved)
    XCTAssertTrue(granted.continuationPending)
    XCTAssertNotNil(card.error)
    fixture.state.withLock { $0.failContinuation = false }
    await card.decide(.approve)
    let continued = try await card.read()
    XCTAssertFalse(continued.continuationPending)
    XCTAssertEqual(fixture.state.withLock { $0.grants }, 1)
    XCTAssertEqual(fixture.state.withLock { $0.continuations }, 1)
  }

  func testLostApprovalResponseIsReadBackWithoutReplayingTheWrite() async throws {
    let fixture = SSHAuthorizationFixture()
    fixture.state.withLock { $0.loseResponse = true }
    let card = try fixture.card()
    card.activate()
    defer { card.close() }
    await card.decide(.approve)
    let confirmed = try await card.read()
    XCTAssertEqual(confirmed.status, .approved)
    XCTAssertFalse(confirmed.continuationPending)
    await card.decide(.approve)
    XCTAssertEqual(fixture.state.withLock { $0.grants }, 1)
    XCTAssertEqual(fixture.state.withLock { $0.continuations }, 1)
  }

  func testExpiredChangedAndPermissionBlockedRequestsCannotBeApproved() async throws {
    for scenario in ["expired", "stale", "permissions_required", "run_active"] {
      let fixture = SSHAuthorizationFixture()
      fixture.state.withLock {
        if scenario == "expired" {
          $0.expired = true
        } else if scenario == "stale" {
          $0.status = scenario
        } else {
          $0.blocker = scenario
        }
      }
      let card = try fixture.card()
      card.activate()
      defer { card.close() }
      await card.decide(.approve)
      XCTAssertNotNil(card.error)
      XCTAssertEqual(fixture.state.withLock { $0.grants }, 0)
    }
  }

  func testCrossChatReadbackCannotGrantAccess() async throws {
    let fixture = SSHAuthorizationFixture()
    fixture.state.withLock { $0.threadID = UUID().uuidString }
    let card = try fixture.card()
    card.activate()
    defer { card.close() }
    await card.decide(.approve)
    XCTAssertNotNil(card.error)
    XCTAssertEqual(fixture.state.withLock { $0.grants }, 0)
  }

  func testConcurrentTapsShareOneExplicitApprovalAttempt() async throws {
    let gate = ModelResponseGate()
    let began = expectation(description: "Approval reached the API")
    let fixture = SSHAuthorizationFixture { request in
      if request.httpMethod == "POST" {
        began.fulfill()
        await gate.wait()
      }
    }
    let card = try fixture.card()
    card.activate()
    let attempt = Task { await card.decide(.approve) }
    addTeardownBlock { @MainActor in
      card.close()
      gate.open()
      await attempt.value
    }
    await fulfillment(of: [began], timeout: 3)
    await card.decide(.approve)
    gate.open()
    await attempt.value
    let approved = try await card.read()
    XCTAssertEqual(approved.status, .approved)
    XCTAssertEqual(fixture.state.withLock { $0.grants }, 1)
    XCTAssertEqual(fixture.state.withLock { $0.continuations }, 1)
  }

  func testRetiringTheConversationCancelsItsOriginalRead() async throws {
    let gate = ModelResponseGate()
    let began = expectation(description: "Read reached the API")
    let cancelled = expectation(description: "Original read cancelled")
    let fixture = SSHAuthorizationFixture { request in
      if request.httpMethod == "GET" {
        await withTaskCancellationHandler {
          began.fulfill()
          await gate.wait()
        } onCancel: {
          cancelled.fulfill()
        }
      }
    }
    let card = try fixture.card()
    card.activate()
    let pending = Task { try await card.read() }
    addTeardownBlock { @MainActor in
      card.close()
      gate.open()
      _ = await pending.result
    }
    await fulfillment(of: [began], timeout: 3)
    card.close()
    await fulfillment(of: [cancelled], timeout: 3)
    gate.open()
    guard case .failure(let error) = await pending.result else {
      return XCTFail("A retired conversation cannot publish authorization data")
    }
    XCTAssertTrue(error is CancellationError)
  }

  func testReopeningTheRegistryRevalidatesAnExternallyRevokedHost() async throws {
    let fixture = SSHAuthorizationFixture()
    let client = fixture.http.client
    let sync = ChatSync(client: client)
    let commands = ChatCommands(client: client, sync: sync)
    let thread = ChatThread(
      id: SSHAuthorizationFixture.threadID, agentID: UUID().uuidString,
      title: "SSH", createdAt: .now, updatedAt: .now, sortAt: .now, pinnedAt: nil, pinOrder: nil)
    let registry = ApprovalCardRegistry(
      thread: thread, commands: commands, sync: sync, didFail: { _ in }, didContinue: {})
    defer { registry.close() }
    let action = try fixture.action()
    registry.activate()
    await registry.ssh(action).decide(.approve)
    registry.deactivate()
    fixture.state.withLock { $0.status = "revoked" }
    registry.activate()
    let fresh = try await registry.ssh(action).read()
    XCTAssertEqual(fresh.status, .revoked)
    XCTAssertEqual(fixture.state.withLock { $0.grants }, 1)
  }
}

private final class SSHAuthorizationFixture: Sendable {
  static let threadID = "73000000-0000-4000-8000-000000000001"
  static let requestID = "73000000-0000-4000-8000-000000000002"

  struct State: Sendable {
    var status = "pending"
    var threadID = SSHAuthorizationFixture.threadID
    var expired = false
    var blocker: String?
    var pendingContinuation = false
    var failContinuation = false
    var loseResponse = false
    var grants = 0
    var continuations = 0
  }
  final class ServerState: Sendable {
    private let value = Mutex(State())
    func withLock<T>(_ action: (inout State) throws -> T) rethrows -> T {
      try value.withLock { try action(&$0) }
    }
  }
  let state = ServerState()
  let http: ChatHTTPFixture

  init(beforeRequest: @escaping @Sendable (URLRequest) async -> Void = { _ in }) {
    let state = state
    let base = "/api/ssh/authorizations/\(Self.requestID)"
    http = ChatHTTPFixture { request in
      let path = request.url?.path ?? ""
      guard
        (request.httpMethod == "GET" && path == base)
          || (request.httpMethod == "POST" && [base + "/approve", base + "/revoke"].contains(path))
      else { throw URLError(.unsupportedURL) }
      await beforeRequest(request)
      try Task.checkCancellation()
      return state.withLock { value in
        if request.httpMethod == "POST" {
          XCTAssertEqual(String(decoding: chatRequestBody(request), as: UTF8.self), "{}")
          if path.hasSuffix("/revoke") {
            value.status = "revoked"
          } else {
            if value.status == "pending" {
              value.grants += 1
              value.status = "approved"
              value.pendingContinuation = true
            }
            if value.failContinuation {
              return ChatHTTPResponse(
                status: 503, body: "{\"error\":{\"message\":\"Continuation unavailable\"}}")
            }
            value.pendingContinuation = false
            value.continuations += 1
            if value.loseResponse {
              value.loseResponse = false
              return ChatHTTPResponse(
                status: 503, body: "{\"error\":{\"message\":\"Response lost\"}}")
            }
          }
        }
        let blocked = value.blocker.map { "\"\($0)\"" } ?? "null"
        return ChatHTTPResponse(
          body: """
            {"id":"\(Self.requestID)","chatThreadId":"\(value.threadID)",
            "connectionId":"73000000-0000-4000-8000-000000000003",
            "displayName":"staging Mac","username":"staging","host":"mac.example.com","port":22,
            "reason":"Build and test the lifecycle fix","status":"\(value.status)",
            "requestExpiresAt":"\(value.expired ? "2020-01-01T00:00:00Z" : "2099-01-01T00:00:00Z")",
            "enabled":\(value.status == "approved"),"continuationPending":\(value.pendingContinuation),
            "approvalBlockedReason":\(blocked),"requiredPermissions":[]}
            """)
      }
    }
  }

  @MainActor func action() throws -> ChatSSHAuthorizationAction {
    try XCTUnwrap(
      ChatSSHAuthorizationAction.parse(
        "/ssh/authorize/\(Self.requestID)", webURL: http.baseURL, threadID: Self.threadID))
  }

  @MainActor func card() throws -> SSHAuthorizationStore {
    SSHAuthorizationStore(
      action: try action(), threadID: Self.threadID, client: http.client, didFail: { _ in },
      didContinue: {})
  }
}
