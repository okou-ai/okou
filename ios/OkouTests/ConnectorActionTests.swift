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
  private func descriptor(_ fixture: ChatHTTPFixture, reconnect: Bool = false, custom: Bool = false)
    throws -> ChatConnectorAction
  {
    let path =
      reconnect
      ? "/connectors/slack/reconnect/\(F.accountID)"
      : "/connectors/\(custom ? "_internal" : "slack")/connect"
    return try XCTUnwrap(
      ChatConnectorAction.parse(
        path + "?agentId=\(F.agentID)&threadId=\(F.threadID)&callbackPrompt=Continue",
        webURL: fixture.baseURL, agentID: F.agentID, threadID: F.threadID))
  }
  private func store(_ fixture: ChatHTTPFixture) -> ConnectorActionStore {
    let sync = ChatSync(client: fixture.client)
    let commands = ChatCommands(client: fixture.client, sync: sync)
    let thread = ChatThread(
      id: F.threadID, agentID: F.agentID, title: "Connector test", selectedModel: nil,
      createdAt: .distantPast, updatedAt: .distantPast, sortAt: .distantPast, pinnedAt: nil,
      pinOrder: nil, modelSettings: [:], serviceTier: nil, indicator: nil)
    return ConnectorActionStore(
      service: commands.connectorActions, commands: commands, thread: thread, didContinue: {},
      didFail: { _ in })
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
        prompts.withLock { $0.append(String(decoding: chatRequestBody(request), as: UTF8.self)) }
      }
      XCTAssertNotEqual(request.httpMethod, "DELETE")
      return try XCTUnwrap(
        F.response(request, connected: linked.withLock { $0 }, authorized: linked.withLock { $0 }))
    }
    let store = store(fixture)
    defer { store.close() }
    let action = try descriptor(fixture)
    store.activate(action)
    try await eventually { store.active != nil }
    store.submit()
    try await eventually { store.active == nil }
    XCTAssertEqual(prompts.withLock { $0.count }, 1)
    XCTAssertTrue(prompts.withLock { $0[0].contains("\"prompt\":\"Continue\"") })
    guard case .ready(let status) = store.states[action.id] else {
      return XCTFail("Missing verified status")
    }
    XCTAssertTrue(status.complete)
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
    let store = store(fixture)
    defer { store.close() }
    store.activate(try descriptor(fixture))
    try await eventually { store.active != nil }
    store.submit()
    try await eventually { store.active?.browserURL != nil }
    store.browserDismissed()
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
    let store = store(fixture)
    defer { store.close() }
    let action = try descriptor(fixture)
    store.activate(action)
    try await eventually { store.active != nil }
    store.submit()
    try await eventually { store.active?.browserURL != nil }
    store.browserDismissed()
    try await eventually { store.active == nil }
    XCTAssertEqual(callbacks.withLock { $0 }, 1)
  }
  func testDeviceAuthorizationPollsSessionTokenAndCompletesOnlyAfterServerReadiness() async throws {
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
    let store = store(fixture)
    defer { store.close() }
    store.activate(try descriptor(fixture))
    try await eventually { store.active != nil }
    store.submit()
    try await eventually { store.active?.session != nil }
    XCTAssertEqual(store.active?.session?.userCode, "EXAMPLE-CODE")
    store.browserDismissed()
    try await eventually { store.active == nil }
    XCTAssertEqual(polls.withLock { $0 }, 2)
  }
  func testCustomOAuthSavesAdditionalFieldsToTheOperatedAccountBeforeContinuing() async throws {
    let connected = Mutex(false)
    let configured = Mutex(false)
    let fixture = ChatHTTPFixture { request in
      if request.url!.path == "/api/custom-connectors" {
        let custom = F.custom(mode: "oauth").replacingOccurrences(
          of: "\"fields\":[]",
          with:
            "\"fields\":[{\"key\":\"region\",\"label\":\"Region\",\"kind\":\"variable\",\"required\":true}]"
        )
        return ChatHTTPResponse(body: "{\"connectors\":[\(custom)]}")
      }
      if request.url!.path.hasSuffix("/oauth2/start") {
        connected.withLock { $0 = true }
        return ChatHTTPResponse(
          body: "{\"result\":\"connected\",\"connectionId\":\"\(F.accountID)\"}")
      }
      if request.url!.path.hasSuffix("/values") {
        XCTAssertEqual(request.httpMethod, "PUT")
        let body = String(decoding: chatRequestBody(request), as: UTF8.self)
        XCTAssertTrue(body.contains(F.accountID))
        XCTAssertTrue(body.contains("eu-west"))
        configured.withLock { $0 = true }
        return ChatHTTPResponse(body: "{\"connectionId\":\"\(F.accountID)\"}")
      }
      if request.url!.path == "/api/connector-accounts/\(F.accountID)" {
        return ChatHTTPResponse(
          body: F.account(custom: true).replacingOccurrences(
            of: "\"setupStatus\":\"complete\"",
            with: "\"setupStatus\":\"\(configured.withLock { $0 } ? "complete" : "incomplete")\""))
      }
      return try XCTUnwrap(
        F.response(request, connected: connected.withLock { $0 }, customMode: "oauth"))
    }
    let store = store(fixture)
    defer { store.close() }
    store.activate(try descriptor(fixture, custom: true))
    try await eventually { store.active != nil }
    XCTAssertFalse(try XCTUnwrap(store.active).canSubmit)
    store.active?.values["region"] = "eu-west"
    store.submit()
    try await eventually { store.active == nil }
    XCTAssertTrue(configured.withLock { $0 })
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
  func testNativeCardKeepsHeightWhileLoadingAndAfterRefreshAndShowsConfirmationSheet() async throws
  {
    let fixture = ChatHTTPFixture { request in try XCTUnwrap(F.response(request)) }
    let store = store(fixture)
    defer { store.close() }
    let action = try descriptor(fixture, reconnect: true)
    let host = UIHostingController(rootView: ConnectorCardHarness(action: action, store: store))
    let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
    let window = UIWindow(windowScene: scene)
    window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
    window.rootViewController = host
    window.makeKeyAndVisible()
    host.view.layoutIfNeeded()
    defer { unmount(window) }
    let size = host.sizeThatFits(in: CGSize(width: 350, height: CGFloat.greatestFiniteMagnitude))
    await store.refresh(action)
    host.view.layoutIfNeeded()
    XCTAssertEqual(
      host.sizeThatFits(in: CGSize(width: 350, height: CGFloat.greatestFiniteMagnitude)).height,
      size.height, accuracy: 1)
    store.activate(action)
    try await eventually { host.presentedViewController != nil }
    let sheet = try XCTUnwrap(host.presentedViewController)
    await store.refreshKnown()
    XCTAssertTrue(host.presentedViewController === sheet)
    if let transition = sheet.transitionCoordinator {
      await withCheckedContinuation { continuation in
        if !transition.animate(alongsideTransition: nil, completion: { _ in continuation.resume() })
        {
          continuation.resume()
        }
      }
    }
    let attachment = XCTAttachment(
      image: UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
        window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
      })
    attachment.name = "Native exact-account connector confirmation"
    attachment.lifetime = .keepAlways
    add(attachment)
    store.cancel()
    try await eventually { host.presentedViewController == nil }
  }
  func testNativeCardInDarkChineseWithLargeText() async throws {
    let fixture = ChatHTTPFixture { request in try XCTUnwrap(F.response(request)) }
    let store = store(fixture)
    defer { store.close() }
    let action = try descriptor(fixture, reconnect: true)
    await store.refresh(action)
    let host = UIHostingController(
      rootView:
        ScrollView {
          VStack(alignment: .leading, spacing: 20) {
            Text("连接 Slack 后继续对话").font(.title2)
            ConnectorActionCard(action: action, store: store, loadsState: false)
            Text("普通消息和链接保持可选择、可复制。").textSelection(.enabled)
          }.padding(20)
        }.environment(\.locale, Locale(identifier: "zh-Hans"))
        .environment(\.dynamicTypeSize, .accessibility1)
        .preferredColorScheme(.dark))
    let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
    let window = UIWindow(windowScene: scene)
    window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
    window.rootViewController = host
    window.makeKeyAndVisible()
    defer { unmount(window) }
    host.view.layoutIfNeeded()
    let attachment = XCTAttachment(
      image: UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
        window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
      })
    attachment.name = "Connector card dark Chinese accessibility text"
    attachment.lifetime = .keepAlways
    add(attachment)
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
