import ChatData
import ChatDataTestSupport
import ChatDomain
import SwiftUI
import Synchronization
import XCTest

@testable import Okou

private typealias F = ConnectorHTTPFixtures

@MainActor
final class ConnectorActionTests: XCTestCase {
  private func descriptor(
    _ fixture: ChatHTTPFixture, reconnect: Bool = false, custom: Bool = false,
    callbackQuery: String = "Continue"
  ) throws -> ChatConnectorAction {
    let path =
      reconnect
      ? "/connectors/slack/reconnect/\(F.accountID)"
      : "/connectors/\(custom ? "_internal" : "slack")/connect"
    return try XCTUnwrap(
      ChatConnectorAction.parse(
        path + "?agentId=\(F.agentID)&threadId=\(F.threadID)&callbackPrompt=\(callbackQuery)",
        webURL: fixture.baseURL, agentID: F.agentID, threadID: F.threadID))
  }
  private func store(
    _ fixture: ChatHTTPFixture,
    pollSleep: @escaping @Sendable (Duration) async throws -> Void = {
      try await Task.sleep(for: $0)
    }
  ) -> ConnectorActionStore {
    let sync = ChatSync(client: fixture.client)
    let commands = ChatCommands(client: fixture.client, sync: sync)
    let thread = ChatThread(
      id: F.threadID, agentID: F.agentID, title: "Connector test", selectedModel: nil,
      createdAt: .distantPast, updatedAt: .distantPast, sortAt: .distantPast, pinnedAt: nil,
      pinOrder: nil, modelSettings: [:], serviceTier: nil, indicator: nil)
    return ConnectorActionStore(
      service: commands.connectorActions, commands: commands, thread: thread, didContinue: {},
      didFail: { _ in }, pollSleep: pollSleep)
  }
  func testNoAuthConnectionVerifiesServerStateAndContinuesWithoutClearingSelection() async throws {
    let linked = Mutex(false)
    let prompts = Mutex<[String]>([])
    let fixture = ChatHTTPFixture { request in
      if request.url!.path == "/api/connectors/slack/no-auth" {
        linked.withLock { $0 = true }
        return ChatHTTPResponse(body: "{\"connectionId\":\"\(F.accountID)\"}")
      }
      if request.url!.path == "/api/chat/events" {
        struct Body: Decodable { let prompt: String }
        let body = try JSONDecoder().decode(Body.self, from: chatRequestBody(request))
        prompts.withLock { $0.append(body.prompt) }
      }
      XCTAssertNotEqual(request.httpMethod, "DELETE")
      return try XCTUnwrap(
        F.response(request, connected: linked.withLock { $0 }, authorized: linked.withLock { $0 }))
    }
    let store = store(fixture)
    defer { store.close() }
    let action = try descriptor(fixture, callbackQuery: "I+connected+Slack%2BChat")
    store.activate(action)
    try await eventually { store.active != nil }
    store.submit()
    try await eventually { store.active == nil }
    XCTAssertEqual(prompts.withLock { $0 }, ["I connected Slack+Chat"])
    guard case .ready(let status) = store.states[action.id] else {
      return XCTFail("Missing verified status")
    }
    XCTAssertTrue(status.complete)
  }
  func testSavedAccountsWithoutDefaultDoNotOpenAnAddFlow() async throws {
    let fixture = ChatHTTPFixture { request in
      XCTAssertEqual(request.httpMethod, "GET")
      if request.url?.path == "/api/connector-accounts/connections" {
        return ChatHTTPResponse(
          body: """
            {"connections":[\(F.account(isDefault: false))],"nextCursor":null,"defaultConnection":null}
            """)
      }
      return try XCTUnwrap(F.response(request))
    }
    let store = store(fixture)
    defer { store.close() }
    let action = try descriptor(fixture)
    store.activate(action)
    try await eventually {
      if case .failed = store.states[action.id] { return true }
      return false
    }
    XCTAssertNil(store.active)
  }
  func testExactReconnectRejectsASiblingReceiptAndAllowsRetry() async throws {
    let starts = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      if request.url!.path == "/api/connectors/slack/no-auth" {
        starts.withLock { $0 += 1 }
        return ChatHTTPResponse(body: "{\"connectionId\":\"\(F.siblingID)\"}")
      }
      XCTAssertNotEqual(request.url!.path, "/api/chat/events")
      return try XCTUnwrap(F.response(request))
    }
    let store = store(fixture)
    defer { store.close() }
    store.activate(try descriptor(fixture, reconnect: true))
    try await eventually { store.active != nil }
    store.submit()
    try await eventually { store.active?.error != nil && store.active?.busy == false }
    XCTAssertTrue(try XCTUnwrap(store.active).canSubmit)
    store.submit()
    try await eventually { starts.withLock { $0 } == 2 && store.active?.busy == false }
  }
  func testUncertainContinuationRetriesTheSameEventWithoutAnotherReconnect() async throws {
    let starts = Mutex(0)
    let eventIDs = Mutex<[String]>([])
    let fixture = ChatHTTPFixture { request in
      if request.url!.path == "/api/connectors/slack/no-auth" {
        starts.withLock { $0 += 1 }
        return ChatHTTPResponse(body: "{\"connectionId\":\"\(F.accountID)\"}")
      }
      if request.url!.path == "/api/chat/events" {
        struct Body: Decodable { let clientEventId: String }
        let body = try JSONDecoder().decode(Body.self, from: chatRequestBody(request))
        let count = eventIDs.withLock {
          $0.append(body.clientEventId)
          return $0.count
        }
        if count == 1 { throw URLError(.networkConnectionLost) }
      }
      return try XCTUnwrap(F.response(request))
    }
    let store = store(fixture)
    defer { store.close() }
    store.activate(try descriptor(fixture, reconnect: true))
    try await eventually { store.active != nil }
    store.submit()
    try await eventually { store.active?.error != nil && store.active?.busy == false }
    XCTAssertTrue(try XCTUnwrap(store.active).canSubmit)
    store.submit()
    try await eventually { store.active == nil }
    XCTAssertEqual(starts.withLock { $0 }, 1)
    XCTAssertEqual(eventIDs.withLock { Set($0).count }, 1)
    XCTAssertEqual(eventIDs.withLock { $0.count }, 2)
  }
  func testOAuthBrowserCancellationDoesNotContinueAndCanRestart() async throws {
    let clock = ConnectorPollingClock()
    let reads = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      if request.url!.path == "/api/connectors/slack/oauth/start" {
        return ChatHTTPResponse(
          body:
            "{\"authorizationUrl\":\"https://auth.example.invalid/start\",\"oauthAttemptId\":\"\(F.attemptID)\"}"
        )
      }
      if request.url!.path.contains("oauth-completions") {
        reads.withLock { $0 += 1 }
        return ChatHTTPResponse(status: 404, body: "{\"error\":{\"message\":\"Pending\"}}")
      }
      XCTAssertNotEqual(request.url!.path, "/api/chat/events")
      return try XCTUnwrap(
        F.response(request, connected: false, authorized: false, grantKind: "auth-code"))
    }
    let store = store(fixture, pollSleep: clock.sleep)
    defer { store.close() }
    store.activate(try descriptor(fixture))
    try await eventually { store.active != nil }
    store.submit()
    try await eventually { store.active?.browserURL != nil && clock.hasSleeper(.seconds(2)) }
    XCTAssertEqual(reads.withLock { $0 }, 0)
    store.browserDismissed()
    clock.advance(.seconds(2))
    try await eventually { store.active?.notice != nil }
    XCTAssertEqual(reads.withLock { $0 }, 1)
    XCTAssertNil(store.active?.session)
    XCTAssertTrue(try XCTUnwrap(store.active).canSubmit)
  }
  func testClosingScopeBeforeALateStartResponseCannotContinue() async throws {
    let started = expectation(description: "Start request reached the HTTP boundary")
    let gate = ModelResponseGate()
    let callbacks = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      if request.url!.path == "/api/connectors/slack/no-auth" {
        started.fulfill()
        await gate.wait()
        return ChatHTTPResponse(body: "{\"connectionId\":\"\(F.accountID)\"}")
      }
      if request.url!.path == "/api/chat/events" { callbacks.withLock { $0 += 1 } }
      return try XCTUnwrap(F.response(request, connected: false, authorized: false))
    }
    let store = store(fixture)
    store.activate(try descriptor(fixture))
    try await eventually { store.active != nil }
    store.submit()
    await fulfillment(of: [started], timeout: 3)
    store.close()
    gate.open()
    XCTAssertNil(store.active)
    XCTAssertTrue(store.states.isEmpty)
    XCTAssertEqual(callbacks.withLock { $0 }, 0)
  }
  func testExternalCodeKeepsExactAccountAndCanRetryAFailedCode() async throws {
    let linked = Mutex(false)
    let submissions = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      if request.url!.path.hasSuffix("/external-code/sessions") {
        return ChatHTTPResponse(
          body:
            "{\"sessionId\":\"\(F.attemptID)\",\"sessionToken\":\"synthetic-session\",\"authorizationUrl\":\"https://auth.example.invalid/code\",\"expiresIn\":300}"
        )
      }
      if request.url!.path.hasSuffix("/complete") {
        let count = submissions.withLock {
          $0 += 1
          return $0
        }
        if count == 1 {
          return ChatHTTPResponse(status: 400, body: "{\"error\":{\"message\":\"Invalid code\"}}")
        }
        linked.withLock { $0 = true }
        return ChatHTTPResponse(
          body: "{\"status\":\"complete\",\"connectionId\":\"\(F.accountID)\"}")
      }
      return try XCTUnwrap(
        F.response(request, connected: linked.withLock { $0 }, grantKind: "external-code"))
    }
    let store = store(fixture)
    defer { store.close() }
    store.activate(try descriptor(fixture, reconnect: true))
    try await eventually { store.active != nil }
    store.submit()
    try await eventually { store.active?.isExternalCode == true && store.active?.busy == false }
    store.active?.code = "wrong-code"
    store.submit()
    try await eventually { store.active?.error != nil && store.active?.busy == false }
    store.active?.code = "correct-code"
    store.submit()
    try await eventually { store.active == nil }
    XCTAssertEqual(submissions.withLock { $0 }, 2)
  }
  func testOAuthCompletionReceiptVerifiesOwnedAccountBeforeContinuing() async throws {
    let clock = ConnectorPollingClock()
    let connected = Mutex(false)
    let callbacks = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      if request.url!.path == "/api/connectors/slack/oauth/start" {
        return ChatHTTPResponse(
          body:
            "{\"authorizationUrl\":\"https://auth.example.invalid/start\",\"oauthAttemptId\":\"\(F.attemptID)\"}"
        )
      }
      if request.url!.path.contains("oauth-completions") {
        connected.withLock { $0 = true }
        return ChatHTTPResponse(body: "{\"connectionId\":\"\(F.accountID)\"}")
      }
      if request.url!.path == "/api/chat/events" { callbacks.withLock { $0 += 1 } }
      return try XCTUnwrap(
        F.response(request, connected: connected.withLock { $0 }, grantKind: "auth-code"))
    }
    let store = store(fixture, pollSleep: clock.sleep)
    defer { store.close() }
    let action = try descriptor(fixture)
    store.activate(action)
    try await eventually { store.active != nil }
    store.submit()
    try await eventually { store.active?.browserURL != nil && clock.hasSleeper(.seconds(2)) }
    XCTAssertEqual(callbacks.withLock { $0 }, 0)
    store.browserDismissed()
    clock.advance(.seconds(2))
    try await eventually { store.active == nil }
    XCTAssertEqual(callbacks.withLock { $0 }, 1)
  }
  func testDeviceAuthorizationPollsSessionTokenAndCompletesOnlyAfterServerReadiness() async throws {
    let clock = ConnectorPollingClock()
    let connected = Mutex(false)
    let polls = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      if request.url!.path.hasSuffix("/oauth/device/sessions") {
        return ChatHTTPResponse(
          body:
            "{\"sessionId\":\"\(F.attemptID)\",\"sessionToken\":\"synthetic-session\",\"userCode\":\"EXAMPLE-CODE\",\"verificationUri\":\"https://auth.example.invalid/device\",\"expiresIn\":300,\"interval\":1}"
        )
      }
      if request.url!.path.hasSuffix("/poll") {
        XCTAssertTrue(
          String(decoding: chatRequestBody(request), as: UTF8.self).contains("synthetic-session"))
        let count = polls.withLock {
          $0 += 1
          return $0
        }
        if count == 1 { return ChatHTTPResponse(body: "{\"status\":\"pending\",\"interval\":1}") }
        connected.withLock { $0 = true }
        return ChatHTTPResponse(
          body: "{\"status\":\"complete\",\"connectionId\":\"\(F.accountID)\"}")
      }
      return try XCTUnwrap(
        F.response(request, connected: connected.withLock { $0 }, grantKind: "device-auth"))
    }
    let store = store(fixture, pollSleep: clock.sleep)
    defer { store.close() }
    store.activate(try descriptor(fixture))
    try await eventually { store.active != nil }
    store.submit()
    try await eventually { store.active?.session != nil && clock.hasSleeper(.seconds(1)) }
    XCTAssertEqual(store.active?.session?.userCode, "EXAMPLE-CODE")
    XCTAssertEqual(polls.withLock { $0 }, 0)
    store.browserDismissed()
    clock.advance(.seconds(1))
    try await eventually { polls.withLock { $0 } == 1 && clock.hasSleeper(.seconds(1)) }
    XCTAssertNotNil(store.active)
    clock.advance(.seconds(1))
    try await eventually { store.active == nil }
    XCTAssertEqual(polls.withLock { $0 }, 2)
  }
  func testCustomOAuthAndAutomaticDoNotRequestProviderOwnedCredentialFields() async throws {
    for mode in ["oauth", "automatic"] {
      let clock = ConnectorPollingClock()
      let connected = Mutex(false)
      let callbacks = Mutex(0)
      let fixture = ChatHTTPFixture { request in
        if request.url!.path == "/api/custom-connectors" {
          let fields =
            mode == "oauth"
            ? "[{\"key\":\"access_token\",\"label\":\"Access token\",\"kind\":\"secret\",\"required\":true}]"
            : "[]"
          let custom = F.custom(mode: mode).replacingOccurrences(
            of: "\"fields\":[]", with: "\"fields\":\(fields)")
          return ChatHTTPResponse(body: "{\"connectors\":[\(custom)]}")
        }
        if request.url!.path.hasSuffix("/oauth2/start") {
          XCTAssertEqual(request.httpMethod, "POST")
          let body = String(decoding: chatRequestBody(request), as: UTF8.self)
          XCTAssertFalse(body.contains("access_token"))
          XCTAssertFalse(body.contains("values"))
          if mode == "oauth" {
            return ChatHTTPResponse(
              body:
                "{\"result\":\"authorization\",\"authorizationUrl\":\"https://auth.example.invalid/start\",\"oauthAttemptId\":\"\(F.attemptID)\"}"
            )
          }
          connected.withLock { $0 = true }
          return ChatHTTPResponse(
            body: "{\"result\":\"connected\",\"connectionId\":\"\(F.accountID)\"}")
        }
        if request.url!.path.contains("oauth-completions") {
          connected.withLock { $0 = true }
          return ChatHTTPResponse(body: "{\"connectionId\":\"\(F.accountID)\"}")
        }
        XCTAssertFalse(request.url!.path.hasSuffix("/values"))
        if request.url!.path == "/api/chat/events" {
          XCTAssertTrue(connected.withLock { $0 })
          callbacks.withLock { $0 += 1 }
        }
        return try XCTUnwrap(
          F.response(request, connected: connected.withLock { $0 }, customMode: mode))
      }
      let store = store(fixture, pollSleep: clock.sleep)
      defer { store.close() }
      store.activate(try descriptor(fixture, custom: true))
      try await eventually { store.active != nil }
      XCTAssertTrue(try XCTUnwrap(store.active).canSubmit)
      XCTAssertTrue(try XCTUnwrap(store.active).values.isEmpty)
      store.submit()
      if mode == "oauth" {
        try await eventually { clock.hasSleeper(.seconds(2)) }
        XCTAssertEqual(callbacks.withLock { $0 }, 0)
        clock.advance(.seconds(2))
      }
      try await eventually { store.active == nil }
      XCTAssertEqual(callbacks.withLock { $0 }, 1)
    }
  }
  func testAccountConfirmationUsesPUTAndPreservesTheSelectionWhileContinuing() async throws {
    let selected = Mutex(false)
    let callbacks = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      if request.url!.path.hasSuffix("/connector-selections") {
        if request.httpMethod == "PUT" {
          XCTAssertTrue(
            String(decoding: chatRequestBody(request), as: UTF8.self).contains(F.accountID))
          selected.withLock { $0 = true }
          return ChatHTTPResponse(body: "{}")
        }
        XCTAssertEqual(request.httpMethod, "GET")
        let selection =
          "{\"connectionId\":\"\(F.accountID)\",\"target\":{\"kind\":\"builtin\",\"connectorSlug\":\"slack\"}}"
        return ChatHTTPResponse(
          body: "{\"selections\":\(selected.withLock { $0 } ? "[\(selection)]" : "[]")}")
      }
      if request.url!.path == "/api/chat/events" {
        XCTAssertTrue(selected.withLock { $0 })
        callbacks.withLock { $0 += 1 }
      }
      return try XCTUnwrap(F.response(request))
    }
    let store = store(fixture)
    defer { store.close() }
    let action = try XCTUnwrap(
      ChatConnectorAction.parse(
        "/agents/\(F.agentID)/connector-accounts/\(F.accountID)/select?kind=builtin&connectorSlug=slack&threadId=\(F.threadID)&callbackPrompt=Continue",
        webURL: fixture.baseURL, agentID: F.agentID, threadID: F.threadID))
    store.activate(action)
    try await eventually { store.active != nil }
    store.submit()
    try await eventually { store.active == nil }
    XCTAssertEqual(callbacks.withLock { $0 }, 1)
    guard case .ready(let status) = store.states[action.id] else {
      return XCTFail("Expected confirmed status")
    }
    XCTAssertTrue(status.selected)
  }

  func testDevicePollingHonorsTheUpdatedIntervalAndScopeClosureCancelsItsWait() async throws {
    let clock = ConnectorPollingClock()
    let polls = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      if request.url!.path.hasSuffix("/oauth/device/sessions") {
        return ChatHTTPResponse(
          body:
            "{\"sessionId\":\"\(F.attemptID)\",\"sessionToken\":\"synthetic-session\",\"userCode\":\"EXAMPLE-CODE\",\"verificationUri\":\"https://auth.example.invalid/device\",\"expiresIn\":300,\"interval\":1}"
        )
      }
      if request.url!.path.hasSuffix("/poll") {
        polls.withLock { $0 += 1 }
        return ChatHTTPResponse(body: "{\"status\":\"pending\",\"interval\":7}")
      }
      XCTAssertNotEqual(request.url!.path, "/api/chat/events")
      return try XCTUnwrap(
        F.response(request, connected: false, authorized: false, grantKind: "device-auth"))
    }
    let store = store(fixture, pollSleep: clock.sleep)
    defer { store.close() }
    store.activate(try descriptor(fixture))
    try await eventually { store.active != nil }
    store.submit()
    try await eventually { clock.hasSleeper(.seconds(1)) }
    XCTAssertEqual(polls.withLock { $0 }, 0)
    clock.advance(.seconds(1))
    try await eventually { clock.hasSleeper(.seconds(7)) }
    XCTAssertEqual(polls.withLock { $0 }, 1)
    store.close()
    try await eventually { !clock.hasSleeper(.seconds(7)) }
    XCTAssertNil(store.active)
    XCTAssertTrue(store.states.isEmpty)
    XCTAssertEqual(polls.withLock { $0 }, 1)
  }

}

private final class ConnectorPollingClock: Sendable {
  private struct Sleeper: Sendable {
    let duration: Duration
    let tick: AsyncStream<Void>.Continuation
  }
  private let sleepers = Mutex<[UUID: Sleeper]>([:])

  func sleep(_ duration: Duration) async throws {
    try Task.checkCancellation()
    let id = UUID()
    let ticks = AsyncStream<Void>.makeStream()
    sleepers.withLock { $0[id] = Sleeper(duration: duration, tick: ticks.continuation) }
    defer {
      _ = sleepers.withLock { $0.removeValue(forKey: id) }
      ticks.continuation.finish()
    }
    for await _ in ticks.stream { break }
    try Task.checkCancellation()
  }

  func hasSleeper(_ duration: Duration) -> Bool {
    sleepers.withLock { $0.values.contains { $0.duration == duration } }
  }

  func advance(_ duration: Duration) {
    let ready = sleepers.withLock { value in
      let ready = value.filter { $0.value.duration == duration }
      for id in ready.keys { value.removeValue(forKey: id) }
      return ready.values.map(\.tick)
    }
    for tick in ready {
      tick.yield(())
      tick.finish()
    }
  }
}

private struct ConnectorCardHarness: View {
  let action: ChatConnectorAction
  let store: ConnectorActionStore
  var body: some View {
    ConnectorActionCard(action: action, store: store, loadsState: false)
      .sheet(item: Binding(get: { store.active }, set: { if $0 == nil { store.cancel() } })) {
        flow in
        ConnectorAuthorizationSheet(flow: flow, store: store)
      }
  }
}
