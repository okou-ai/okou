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

  func testCancelledReadWaiterDoesNotCancelTheSharedOriginalHTTP() async throws {
    let began = expectation(description: "Authorization HTTP began")
    let gate = ModelResponseGate()
    let fixture = ComputerAuthorizationFixture(kind: .browser) { request in
      guard request.httpMethod == "GET",
        request.url?.path.contains("authorization-requests") == true
      else { return }
      began.fulfill()
      await gate.wait()
      XCTAssertFalse(Task.isCancelled)
    }
    let card = try fixture.card(callback: true)
    card.activate()
    defer { card.close() }
    let first = Task { try await card.read() }
    let second = Task { try await card.read() }
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
    let current = try await second.value
    XCTAssertEqual(current.status, .pending)
    guard case .failure(let error) = await first.result else {
      return XCTFail("A cancelled row cannot publish the shared authorization")
    }
    XCTAssertTrue(error is CancellationError)
    XCTAssertEqual(fixture.state.withLock { $0.grantWrites }, 0)
    XCTAssertTrue(fixture.state.withLock { $0.inputs.isEmpty })
  }

  func testRetiredDetailCannotReturnACachedAuthorizationAndReentryRevalidates() async throws {
    let fixture = ComputerAuthorizationFixture(kind: .shell)
    let conversation = fixture.conversation()
    defer { conversation.close() }
    let owner = UUID()
    conversation.setDetailVisible(true, owner: owner)
    let card = conversation.approvals.computer(try fixture.action(callback: true))
    let original = try await card.read()
    XCTAssertEqual(original.status, .pending)
    fixture.state.withLock { $0.status = "approved" }
    conversation.setDetailVisible(false, owner: owner)
    do {
      _ = try await card.read()
      XCTFail("A retired detail cannot publish its cached authorization")
    } catch is CancellationError {}
    conversation.setDetailVisible(true, owner: UUID())
    let fresh = try await card.read()
    XCTAssertEqual(fresh.status, .approved)
    XCTAssertEqual(fixture.state.withLock { $0.grantWrites }, 0)
    XCTAssertTrue(fixture.state.withLock { $0.inputs.isEmpty })
  }

  func testDetailRetirementCancelsOriginalHTTPAndFencesItsOldWaiter() async throws {
    let began = expectation(description: "Original authorization HTTP began")
    let cancelled = expectation(description: "Original authorization HTTP cancelled")
    let gate = ModelResponseGate()
    let reads = Mutex(0)
    let fixture = ComputerAuthorizationFixture(kind: .browser) { request in
      guard request.httpMethod == "GET",
        request.url?.path.contains("authorization-requests") == true
      else { return }
      let first = reads.withLock { count in
        count += 1
        return count == 1
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
    let conversation = fixture.conversation()
    defer { conversation.close() }
    let owner = UUID()
    conversation.setDetailVisible(true, owner: owner)
    let card = conversation.approvals.computer(try fixture.action(callback: true))
    let pending = Task { try await card.read() }
    addTeardownBlock { @MainActor in
      pending.cancel()
      gate.open()
      _ = await pending.result
    }
    await fulfillment(of: [began], timeout: 3)
    conversation.setDetailVisible(false, owner: owner)
    await fulfillment(of: [cancelled], timeout: 3)
    fixture.state.withLock { $0.status = "approved" }
    conversation.setDetailVisible(true, owner: UUID())
    let fresh = try await card.read()
    XCTAssertEqual(fresh.status, .approved)
    gate.open()
    guard case .failure(let error) = await pending.result else {
      return XCTFail("The old detail cannot publish into the new visit")
    }
    XCTAssertTrue(error is CancellationError)
  }

  func testExplicitRefreshReplacesAPendingReadForItsSurvivingWaiter() async throws {
    let began = expectation(description: "Original authorization HTTP began")
    let cancelled = expectation(description: "Refresh cancelled the original HTTP")
    let gate = ModelResponseGate()
    let reads = Mutex(0)
    let fixture = ComputerAuthorizationFixture(kind: .browser) { request in
      guard request.httpMethod == "GET",
        request.url?.path.contains("authorization-requests") == true
      else { return }
      let first = reads.withLock { count in
        count += 1
        return count == 1
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
    let card = try fixture.card(callback: true)
    card.activate()
    defer { card.close() }
    let pending = Task { try await card.read() }
    addTeardownBlock { @MainActor in
      pending.cancel()
      gate.open()
      _ = await pending.result
    }
    await fulfillment(of: [began], timeout: 3)
    fixture.state.withLock { $0.status = "approved" }
    await card.refresh()
    await fulfillment(of: [cancelled], timeout: 3)
    gate.open()
    let fresh = try await pending.value
    XCTAssertEqual(fresh.status, .approved)
    XCTAssertEqual(fixture.state.withLock { $0.grantWrites }, 0)
    XCTAssertTrue(fixture.state.withLock { $0.inputs.isEmpty })
  }

  func testDeniedReadsStayFailedUntilExplicitRetryWithoutGrantingAccess() async throws {
    for status in [401, 403, 426] {
      let fixture = ComputerAuthorizationFixture(kind: .browser)
      let card = try fixture.card(callback: true)
      card.activate()
      defer { card.close() }
      fixture.state.withLock { $0.readStatus = status }
      await card.refresh()
      fixture.state.withLock { $0.readStatus = 200 }
      do {
        _ = try await card.read()
        XCTFail("An observed failure stays failed until explicit retry")
      } catch let error as APIClientError { XCTAssertEqual(error.statusCode, status) }
      await card.refresh()
      let fresh = try await card.read()
      XCTAssertEqual(fresh.status, .pending)
      XCTAssertEqual(fixture.state.withLock { $0.grantWrites }, 0)
      XCTAssertTrue(fixture.state.withLock { $0.inputs.isEmpty })
    }
  }

  func testRegistryKeepsUncertainGrantAndCallbackIdentityAcrossReturnAndReadPressure() async throws
  {
    let fixture = ComputerAuthorizationFixture(kind: .computerUse)
    fixture.state.withLock { $0.loseGrantResponse = true }
    let conversation = fixture.conversation()
    defer { conversation.close() }
    let owner = UUID()
    conversation.setDetailVisible(true, owner: owner)
    let action = try fixture.action(callback: true)
    await conversation.approvals.computer(action).decide(.approve)
    let approved = try await conversation.approvals.computer(action).read()
    XCTAssertEqual(approved.status, .approved)
    XCTAssertTrue(fixture.state.withLock { $0.inputs.isEmpty })
    conversation.setDetailVisible(false, owner: owner)
    for index in 0..<100 {
      _ = conversation.approvals.computer(
        try fixture.action(callback: false, identifier: "another_token_\(index)"))
    }
    conversation.setDetailVisible(true, owner: UUID())
    await conversation.approvals.computer(action).refresh()
    XCTAssertTrue(fixture.state.withLock { $0.inputs.isEmpty })
    await conversation.approvals.computer(action).decide(.approve)
    let inputs = fixture.state.withLock { $0.inputs }
    XCTAssertEqual(inputs.count, 1)
    XCTAssertEqual(inputs.first?["clientEventId"]?.string, ComputerAuthorizationFixture.requestID)
    XCTAssertEqual(
      inputs.first?["chatThreadSortEventId"]?.string, ComputerAuthorizationFixture.requestID)
    XCTAssertEqual(fixture.state.withLock { $0.grantWrites }, 1)
  }

  func testConversationCloseCancelsOriginalReadAndRejectsRecycledRows() async throws {
    let began = expectation(description: "Authorization HTTP began")
    let cancelled = expectation(description: "Close cancelled original authorization HTTP")
    let gate = ModelResponseGate()
    let fixture = ComputerAuthorizationFixture(kind: .browser) { request in
      guard request.httpMethod == "GET",
        request.url?.path.contains("authorization-requests") == true
      else { return }
      await withTaskCancellationHandler {
        began.fulfill()
        await gate.wait()
      } onCancel: {
        cancelled.fulfill()
      }
    }
    let conversation = fixture.conversation()
    defer { conversation.close() }
    conversation.setDetailVisible(true, owner: UUID())
    let action = try fixture.action(callback: true)
    let pending = Task { try await conversation.approvals.computer(action).read() }
    addTeardownBlock { @MainActor in
      pending.cancel()
      gate.open()
      _ = await pending.result
    }
    await fulfillment(of: [began], timeout: 3)
    conversation.close()
    await fulfillment(of: [cancelled], timeout: 3)
    gate.open()
    guard case .failure(let error) = await pending.result else {
      return XCTFail("A closed conversation cannot publish authorization reads")
    }
    XCTAssertTrue(error is CancellationError)
    do {
      _ = try await conversation.approvals.computer(action).read()
      XCTFail("A recycled row cannot restart a closed authorization owner")
    } catch is CancellationError {}
    XCTAssertEqual(fixture.state.withLock { $0.grantWrites }, 0)
    XCTAssertTrue(fixture.state.withLock { $0.inputs.isEmpty })
  }

  func testChosenComputerSurvivesReadPressureUntilExplicitAuthorization() async throws {
    let fixture = ComputerAuthorizationFixture(kind: .computerUse)
    fixture.state.withLock { $0.hasSecondHost = true }
    let conversation = fixture.conversation()
    defer { conversation.close() }
    conversation.setDetailVisible(true, owner: UUID())
    let action = try fixture.action(callback: false)
    let initial = try await conversation.approvals.computer(action).read()
    XCTAssertEqual(
      initial.hosts.map(\.id),
      [ComputerAuthorizationFixture.hostID, ComputerAuthorizationFixture.secondHostID])
    conversation.approvals.computer(action).selectHost(ComputerAuthorizationFixture.secondHostID)
    for index in 0..<100 {
      _ = conversation.approvals.computer(
        try fixture.action(callback: false, identifier: "another_token_\(index)"))
    }
    await conversation.approvals.computer(action).decide(.approve)
    XCTAssertEqual(
      fixture.state.withLock { $0.appliedHostID }, ComputerAuthorizationFixture.secondHostID)
    XCTAssertEqual(fixture.state.withLock { $0.grantWrites }, 1)
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
  static let secondHostID = "71000000-0000-4000-8000-000000000005"

  struct State: Sendable {
    var threadID = ComputerAuthorizationFixture.threadID
    var status = "pending"
    var online = true
    var expired = false
    var readStatus = 200
    var hasSecondHost = false
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
              threadPath, threadPath + "/metadata", threadPath + "/event-snapshot",
              threadPath + "/event-rows",
            ]
            .contains(path))
          || (request.httpMethod == "POST" && path == "/api/chat/events")
      else { throw URLError(.unsupportedURL) }
      await beforeRequest(request)
      try Task.checkCancellation()
      return try state.withLock { value in
        if isAuthorizationRead, value.readStatus != 200 {
          return ChatHTTPResponse(
            status: value.readStatus,
            body: "{\"error\":{\"message\":\"Authorization read denied\"}}")
        }
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
          let host = "\"computerUseHostId\":\"\(value.appliedHostID ?? Self.hostID)\""
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
          let secondHost =
            value.hasSecondHost
            ? ",{\"id\":\"\(Self.secondHostID)\",\"displayName\":\"Another Preview Mac\",\"status\":\"online\"}"
            : ""
          return ChatHTTPResponse(
            body:
              "{\(common),\(host),\"source\":\"chat\",\"expiresAt\":\"\(expiration)\",\"completedAt\":\(completion),\"hosts\":[{\"id\":\"\(Self.hostID)\",\"displayName\":\"Preview Mac\",\"status\":\"\(value.online ? "online" : "offline")\"}\(secondHost)]}"
          )
        }
        if path == threadPath {
          return ChatHTTPResponse(body: "{\"cancellationRecoveryPending\":false}")
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
    let action = try action(callback: callback, querySuffix: querySuffix)
    let sync = ChatSync(client: http.client)
    let commands = ChatCommands(client: http.client, sync: sync)
    let thread = ChatThread(
      id: Self.threadID, agentID: Self.agentID, title: "Access", createdAt: .now,
      updatedAt: .now, sortAt: .now, pinnedAt: nil, pinOrder: nil)
    return ComputerAuthorizationStore(
      action: action, thread: thread, commands: commands, sync: sync,
      didFail: { _ in }, didContinue: {})
  }

  @MainActor func action(
    callback: Bool, querySuffix: String = "", identifier: String = "preview_token"
  ) throws -> ChatComputerAuthorizationAction {
    let path: String
    switch kind {
    case .computerUse: path = "/computer-use/authorize/\(identifier)"
    case .browser: path = "/browser/authorize/\(identifier)"
    case .shell: path = "/computer-use/shell/authorize/\(Self.requestID)"
    }
    let query =
      callback
      ? "?callbackPrompt=Continue+%2B+screenshot&threadId=\(Self.threadID)" : ""
    return try XCTUnwrap(
      ChatComputerAuthorizationAction.parse(
        path + query + querySuffix, webURL: http.baseURL, threadID: Self.threadID))
  }

  @MainActor func conversation() -> ConversationStore {
    let sync = ChatSync(client: http.client)
    let commands = ChatCommands(client: http.client, sync: sync)
    let thread = ChatThread(
      id: Self.threadID, agentID: Self.agentID, title: "Access", createdAt: .now,
      updatedAt: .now, sortAt: .now, pinnedAt: nil, pinOrder: nil)
    return ConversationStore(
      thread: thread, sync: sync, commands: commands, webURL: http.baseURL,
      messageMarkdown: MessageMarkdownCache(baseURL: http.baseURL), isVisible: { true },
      didMarkRead: { _ in }, didSend: {}, didFail: { _ in }, didSettle: {})
  }
}
