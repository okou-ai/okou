import ChatData
import ChatDataTestSupport
import ChatDomain
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class ComputerAuthorizationTests: XCTestCase {
  func testAllThreeAccessCardsGrantAndContinueWithTheServerRequestIdentity() async throws {
    for kind in ChatComputerAuthorizationAction.Kind.allCasesForTesting {
      let fixture = ComputerAuthorizationFixture(kind: kind)
      let card = try fixture.card(callback: true)
      defer { card.close() }
      card.activate()
      await card.decide(.approve)
      await card.decide(.approve)
      await card.refresh()
      let request = try await card.read()
      XCTAssertEqual(request.status, .approved)
      let writes = fixture.state.withLock { $0.inputs }
      XCTAssertEqual(writes.count, 1)
      let input = try XCTUnwrap(writes.first)
      XCTAssertEqual(input["clientEventId"]?.string, ComputerAuthorizationFixture.requestID)
      XCTAssertEqual(input["chatThreadSortEventId"]?.string, ComputerAuthorizationFixture.requestID)
      XCTAssertEqual(input["prompt"]?.string, "Continue + screenshot")
      XCTAssertEqual(input["cloudBrowserEnabled"], .bool(kind == .browser))
      XCTAssertEqual(fixture.state.withLock { $0.grantWrites }, 1)
    }
  }

  func testPlainLinksOnlyGrantAccess() async throws {
    for kind in ChatComputerAuthorizationAction.Kind.allCasesForTesting {
      let fixture = ComputerAuthorizationFixture(kind: kind)
      let card = try fixture.card(callback: false)
      defer { card.close() }
      card.activate()
      await card.decide(.approve)
      let approved = try await card.read()
      XCTAssertEqual(approved.status, .approved)
      XCTAssertTrue(fixture.state.withLock { $0.inputs.isEmpty })
    }
  }

  func testCrossChatAndMalformedCallbacksCannotGrantAccess() async throws {
    let fixture = ComputerAuthorizationFixture(kind: .browser)
    let card = try fixture.card(callback: true)
    defer { card.close() }
    card.activate()
    fixture.state.withLock { $0.threadID = UUID().uuidString }
    await card.decide(.approve)
    XCTAssertNotNil(card.error)
    XCTAssertEqual(fixture.state.withLock { $0.grantWrites }, 0)

    let malformed = try fixture.card(callback: true, querySuffix: "&threadId=other-chat")
    defer { malformed.close() }
    malformed.activate()
    await malformed.decide(.approve)
    XCTAssertNotNil(malformed.error)
    XCTAssertEqual(fixture.state.withLock { $0.grantWrites }, 0)
  }

  func testComputerChoiceMustStillBeOnlineWhenAuthorizing() async throws {
    let fixture = ComputerAuthorizationFixture(kind: .computerUse)
    fixture.state.withLock { $0.online = false }
    let card = try fixture.card(callback: true)
    defer { card.close() }
    card.activate()
    await card.decide(.approve)
    XCTAssertEqual(fixture.state.withLock { $0.grantWrites }, 0)
    fixture.state.withLock { $0.online = true }
    await card.decide(.approve)
    let approved = try await card.read()
    XCTAssertEqual(approved.status, .approved)
    XCTAssertEqual(fixture.state.withLock { $0.appliedHostID }, ComputerAuthorizationFixture.hostID)
  }

  func testUncertainGrantWaitsForExplicitRetryAndDoesNotGrantTwice() async throws {
    let fixture = ComputerAuthorizationFixture(kind: .computerUse)
    fixture.state.withLock { $0.loseGrantResponse = true }
    let card = try fixture.card(callback: true)
    defer { card.close() }
    card.activate()
    await card.decide(.approve)
    let approved = try await card.read()
    XCTAssertEqual(approved.status, .approved)
    XCTAssertTrue(fixture.state.withLock { $0.inputs.isEmpty })
    await card.decide(.approve)
    XCTAssertEqual(fixture.state.withLock { $0.grantWrites }, 1)
    XCTAssertEqual(fixture.state.withLock { $0.inputs.count }, 1)
  }

  func testLostContinuationResponseIsReconciledBeforeRetry() async throws {
    let fixture = ComputerAuthorizationFixture(kind: .shell)
    fixture.state.withLock { $0.loseInputResponse = true }
    let card = try fixture.card(callback: true)
    defer { card.close() }
    card.activate()
    await card.decide(.approve)
    XCTAssertNotNil(card.error)
    await card.decide(.approve)
    XCTAssertEqual(fixture.state.withLock { $0.inputs.count }, 1)
    XCTAssertEqual(fixture.state.withLock { $0.grantWrites }, 1)
  }

  func testExpiredRequestAndGrantCannotContinue() async throws {
    for kind in ChatComputerAuthorizationAction.Kind.allCasesForTesting {
      let fixture = ComputerAuthorizationFixture(kind: kind)
      fixture.state.withLock { $0.expired = true }
      let card = try fixture.card(callback: true)
      defer { card.close() }
      card.activate()
      await card.decide(.approve)
      let expired = try await card.read()
      XCTAssertEqual(expired.effectiveStatus(at: .now), .expired)
      XCTAssertTrue(fixture.state.withLock { $0.inputs.isEmpty })
      XCTAssertEqual(fixture.state.withLock { $0.grantWrites }, 0)
    }
  }

  func testShellDenyAndRevokeDoNotContinue() async throws {
    let fixture = ComputerAuthorizationFixture(kind: .shell)
    let card = try fixture.card(callback: true)
    defer { card.close() }
    card.activate()
    await card.decide(.deny)
    let denied = try await card.read()
    XCTAssertEqual(denied.status, .denied)
    fixture.state.withLock { $0.status = "approved" }
    await card.decide(.revoke)
    let revoked = try await card.read()
    XCTAssertEqual(revoked.status, .revoked)
    XCTAssertTrue(fixture.state.withLock { $0.inputs.isEmpty })
  }

  func testRefreshOfAnExternallyApprovedRequestDoesNotStartAnotherRun() async throws {
    let fixture = ComputerAuthorizationFixture(kind: .browser)
    let card = try fixture.card(callback: true)
    defer { card.close() }
    card.activate()
    _ = try await card.read()
    fixture.state.withLock { $0.status = "approved" }
    await card.refresh()
    await card.decide(.approve)
    let approved = try await card.read()
    XCTAssertEqual(approved.status, .approved)
    XCTAssertTrue(fixture.state.withLock { $0.inputs.isEmpty })
  }

  func testConcurrentApprovalClicksShareOneAttempt() async throws {
    let gate = ModelResponseGate()
    let started = expectation(description: "First approval reached the API")
    let fixture = ComputerAuthorizationFixture(kind: .browser) { request in
      if request.url!.path.hasSuffix("/apply") {
        started.fulfill()
        await gate.wait()
      }
    }
    let card = try fixture.card(callback: true)
    card.activate()
    defer {
      gate.open()
      card.close()
    }
    let first = Task { await card.decide(.approve) }
    await fulfillment(of: [started], timeout: 3)
    await card.decide(.approve)
    gate.open()
    await first.value
    XCTAssertEqual(fixture.state.withLock { $0.grantWrites }, 1)
    XCTAssertEqual(fixture.state.withLock { $0.inputs.count }, 1)
  }

  func testClosingDuringAuthorizationCannotContinueARetiredChat() async throws {
    let gate = ModelResponseGate()
    let started = expectation(description: "Grant request reached the API")
    let fixture = ComputerAuthorizationFixture(kind: .browser) { request in
      if request.url!.path.hasSuffix("/apply") {
        started.fulfill()
        await gate.wait()
      }
    }
    let card = try fixture.card(callback: true)
    card.activate()
    defer {
      gate.open()
      card.close()
    }
    let attempt = Task { await card.decide(.approve) }
    await fulfillment(of: [started], timeout: 3)
    card.close()
    gate.open()
    await attempt.value
    XCTAssertTrue(fixture.state.withLock { $0.inputs.isEmpty })
  }
}

extension ChatComputerAuthorizationAction.Kind {
  fileprivate static var allCasesForTesting: [Self] { [.computerUse, .browser, .shell] }
}

private final class ComputerAuthorizationFixture: Sendable {
  static let threadID = "71000000-0000-4000-8000-000000000001"
  static let agentID = "71000000-0000-4000-8000-000000000002"
  static let requestID = "71000000-0000-4000-8000-000000000003"
  static let hostID = "71000000-0000-4000-8000-000000000004"

  struct State: Sendable {
    var threadID = ComputerAuthorizationFixture.threadID
    var status = "pending"
    var online = true
    var expired = false
    var grantWrites = 0
    var appliedHostID: String?
    var loseGrantResponse = false
    var loseInputResponse = false
    var inputs: [[String: MessageJSON]] = []
  }
  final class ServerState: Sendable {
    private let storage = Mutex(State())
    func withLock<T>(_ operation: (inout State) throws -> T) rethrows -> T {
      try storage.withLock { try operation(&$0) }
    }
  }
  let state = ServerState()
  let kind: ChatComputerAuthorizationAction.Kind
  let http: ChatHTTPFixture

  init(
    kind: ChatComputerAuthorizationAction.Kind,
    beforeRequest: @escaping @Sendable (URLRequest) async -> Void = { _ in }
  ) {
    self.kind = kind
    let state = state
    let authorizationPath: String
    switch kind {
    case .computerUse:
      authorizationPath = "/api/computer-use/authorization-requests/preview_token"
    case .browser:
      authorizationPath = "/api/browser/authorization-requests/preview_token"
    case .shell:
      authorizationPath = "/api/computer-use/shell/authorizations/\(Self.requestID)"
    }
    let approvalPath = authorizationPath + (kind == .shell ? "/approve" : "/apply")
    let threadPath = "/api/chat-threads/\(Self.threadID)"
    http = ChatHTTPFixture { request in
      let path = request.url?.path ?? ""
      let isAuthorizationRead = request.httpMethod == "GET" && path == authorizationPath
      let isAuthorizationWrite =
        request.httpMethod == "POST"
        && (path == approvalPath
          || (kind == .shell
            && [authorizationPath + "/deny", authorizationPath + "/revoke"].contains(path)))
      guard
        isAuthorizationRead || isAuthorizationWrite
          || (request.httpMethod == "GET"
            && [
              threadPath + "/metadata", threadPath + "/event-snapshot", threadPath + "/event-rows",
            ]
            .contains(path))
          || (request.httpMethod == "POST" && path == "/api/chat/events")
      else { throw URLError(.unsupportedURL) }
      await beforeRequest(request)
      try Task.checkCancellation()
      return try state.withLock { value in
        let approved = value.status == "approved"
        let expiration = value.expired ? "2020-01-01T00:00:00Z" : "2099-01-01T00:00:00Z"
        if isAuthorizationRead || isAuthorizationWrite {
          if isAuthorizationWrite {
            if path == authorizationPath + "/deny" {
              value.status = "denied"
            } else if path == authorizationPath + "/revoke" {
              value.status = "revoked"
            } else {
              value.grantWrites += 1
              value.status = "approved"
              let body = try JSONDecoder().decode(
                [String: MessageJSON].self, from: chatRequestBody(request))
              value.appliedHostID = body["computerUseHostId"]?.string
              if value.loseGrantResponse {
                value.loseGrantResponse = false
                return ChatHTTPResponse(
                  status: 503, body: "{\"error\":{\"message\":\"Grant response lost\"}}")
              }
            }
            if kind != .shell { return ChatHTTPResponse(body: "{}") }
          }
          let common = "\"id\":\"\(Self.requestID)\",\"chatThreadId\":\"\(value.threadID)\""
          let host = "\"computerUseHostId\":\"\(Self.hostID)\""
          if kind == .shell {
            return ChatHTTPResponse(
              body:
                "{\(common),\(host),\"computerName\":\"Preview Mac\",\"reason\":\"Build and screenshot\",\"status\":\"\(value.status)\",\"approvalBlockedReason\":null,\"requestExpiresAt\":\"\(expiration)\",\"grantExpiresAt\":\"\(expiration)\"}"
            )
          }
          let completion = approved ? "\"2026-11-10T00:00:00Z\"" : "null"
          if kind == .browser {
            return ChatHTTPResponse(
              body:
                "{\(common),\"expiresAt\":\"\(expiration)\",\"completedAt\":\(completion),\"cloudBrowserEnabled\":\(approved)}"
            )
          }
          return ChatHTTPResponse(
            body:
              "{\(common),\(host),\"source\":\"chat\",\"expiresAt\":\"\(expiration)\",\"completedAt\":\(completion),\"hosts\":[{\"id\":\"\(Self.hostID)\",\"displayName\":\"Preview Mac\",\"status\":\"\(value.online ? "online" : "offline")\"}]}"
          )
        }
        if path == threadPath + "/metadata" {
          return ChatHTTPResponse(
            body:
              "{\"id\":\"\(Self.threadID)\",\"agentId\":\"\(Self.agentID)\",\"computerUseHostId\":\(kind == .browser ? "null" : "\"\(Self.hostID)\""),\"cloudBrowserEnabled\":\(kind == .browser)}"
          )
        }
        if path == threadPath + "/event-snapshot" {
          return ChatHTTPResponse(
            status: 404,
            body:
              "{\"error\":{\"code\":\"CHAT_EVENT_SNAPSHOT_NOT_FOUND\",\"message\":\"No snapshot\"}}"
          )
        }
        if path == threadPath + "/event-rows" {
          let rows = value.inputs.map { input -> [String: MessageJSON] in
            [
              "id": .string(Self.requestID), "chatThreadId": .string(Self.threadID),
              "seqId": .number(1), "createdAt": .string("2026-11-10T00:00:00Z"),
              "eventType": .string("input.prompt"),
              "payload": .object(["userMessage": input["userMessage"] ?? .object([:])]),
            ]
          }
          let data = try JSONEncoder().encode(rows)
          return ChatHTTPResponse(
            body:
              "{\"rows\":\(String(decoding: data, as: UTF8.self)),\"cursor\":{\"lastEventId\":\(rows.isEmpty ? "null" : "\"\(Self.requestID)\""),\"lastSeqId\":\(rows.count)},\"hasMore\":false}"
          )
        }
        if path == "/api/chat/events" {
          let input = try JSONDecoder().decode(
            [String: MessageJSON].self, from: chatRequestBody(request))
          value.inputs.append(input)
          if value.loseInputResponse {
            value.loseInputResponse = false
            return ChatHTTPResponse(
              status: 503, body: "{\"error\":{\"message\":\"Input response lost\"}}")
          }
          return ChatHTTPResponse(body: "{\"threadId\":\"\(Self.threadID)\"}")
        }
        throw URLError(.unsupportedURL)
      }
    }
  }

  @MainActor func card(callback: Bool, querySuffix: String = "") throws
    -> ComputerAuthorizationStore
  {
    let path: String
    switch kind {
    case .computerUse: path = "/computer-use/authorize/preview_token"
    case .browser: path = "/browser/authorize/preview_token"
    case .shell: path = "/computer-use/shell/authorize/\(Self.requestID)"
    }
    let query =
      callback
      ? "?callbackPrompt=Continue+%2B+screenshot&threadId=\(Self.threadID)" : ""
    let action = try XCTUnwrap(
      ChatComputerAuthorizationAction.parse(
        path + query + querySuffix, webURL: http.baseURL, threadID: Self.threadID))
    let sync = ChatSync(client: http.client)
    let commands = ChatCommands(client: http.client, sync: sync)
    let thread = ChatThread(
      id: Self.threadID, agentID: Self.agentID, title: "Access", createdAt: .now,
      updatedAt: .now, sortAt: .now, pinnedAt: nil, pinOrder: nil)
    return ComputerAuthorizationStore(
      action: action, thread: thread, commands: commands, sync: sync,
      didFail: { _ in }, didContinue: {})
  }
}
