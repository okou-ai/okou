import ChatData
import ChatDataTestSupport
import Synchronization
import XCTest

@testable import Okou

private typealias FixtureData = ConnectorHTTPFixtures

private struct UnavailableProviderApplication: ConnectorProviderApplication {
  func open(_ url: URL) async -> Bool { false }
}

private let multipleMethodCatalog = """
  {"connector":{"slug":"slack","label":"Slack","description":"Read messages","connectNotice":null,"authMethods":[
    {"id":"oauth","label":"Sign in","grantKind":"auth-code","manualFields":[],"startOptions":[]},
    {"id":"api-token","label":"API token","grantKind":"manual","manualFields":[
      {"id":"token","label":"API token","required":true,"inputType":"password"}
    ],"startOptions":[]}
  ]}}
  """

@MainActor
final class ConnectorConnectEntryTests: XCTestCase {
  func testMultipleMethodsConnectUsingTheChosenCredentials() async throws {
    let connected = Mutex(false)
    let fixture = ChatHTTPFixture { request in
      let path = request.url!.path
      if path == "/api/connector-catalog/slack" {
        return ChatHTTPResponse(body: multipleMethodCatalog)
      }
      if path == "/api/connectors/slack/manual-grant" {
        XCTAssertEqual(request.httpMethod, "POST")
        struct Body: Decodable {
          struct Account: Decodable { let intent: String }
          let account: Account
          let authMethod: String
          let values: [String: String]
        }
        let body = try JSONDecoder().decode(Body.self, from: chatRequestBody(request))
        XCTAssertEqual(body.account.intent, "add")
        XCTAssertEqual(body.authMethod, "api-token")
        XCTAssertEqual(body.values, ["token": "synthetic-token"])
        connected.withLock { $0 = true }
        return ChatHTTPResponse(body: "{\"connectionId\":\"\(FixtureData.accountID)\"}")
      }
      if path == "/api/connector-accounts/\(FixtureData.accountID)" {
        guard connected.withLock({ $0 }) else {
          return ChatHTTPResponse(status: 404, body: "{\"error\":{\"message\":\"Not connected\"}}")
        }
        return ChatHTTPResponse(
          body: FixtureData.account().replacingOccurrences(
            of: "\"authMethod\":\"oauth\"", with: "\"authMethod\":\"api-token\""))
      }
      return try XCTUnwrap(
        FixtureData.response(request, connected: connected.withLock { $0 }))
    }
    let service = ChatConnectorService(client: fixture.client)
    let store = ConnectorActionStore(service: service, didContinue: {}, didFail: { _ in })
    defer { store.close() }
    store.activate(.configuration(target: .builtin("slack"), threadID: nil))
    try await waitForBusinessResult { store.active?.canSubmit == true }
    let flow = try XCTUnwrap(store.active)
    flow.methodID = "api-token"
    flow.values["token"] = "synthetic-token"
    store.submit()
    try await waitForBusinessResult { store.active == nil }
    let account = try await service.account(id: FixtureData.accountID, target: .builtin("slack"))
    XCTAssertTrue(account.ready)
    XCTAssertEqual(account.authMethod, "api-token")
  }

  func testReconnectCanSwitchBothWaysWithoutReplacingTheAccount() async throws {
    let storedMethod = Mutex("oauth")
    let authorized = Mutex(false)
    let scheduled = expectation(description: "Switched OAuth attempt is waiting")
    let clock = ConnectorPollingClock(didSchedule: { _ in scheduled.fulfill() })
    let fixture = ChatHTTPFixture { request in
      let path = request.url!.path
      if path == "/api/connector-catalog/slack" {
        return ChatHTTPResponse(body: multipleMethodCatalog)
      }
      if path == "/api/connector-accounts/\(FixtureData.accountID)" {
        return ChatHTTPResponse(
          body: FixtureData.account().replacingOccurrences(
            of: "\"authMethod\":\"oauth\"",
            with: "\"authMethod\":\"\(storedMethod.withLock { $0 })\""))
      }
      if path == "/api/connectors/slack/manual-grant"
        || path == "/api/connectors/slack/oauth/start"
      {
        struct Body: Decodable {
          struct Account: Decodable {
            let intent: String
            let connectionId: String
          }
          let account: Account
          let authMethod: String
          let values: [String: String]?
        }
        XCTAssertEqual(request.httpMethod, "POST")
        let body = try JSONDecoder().decode(Body.self, from: chatRequestBody(request))
        XCTAssertEqual(body.account.intent, "reconnect")
        XCTAssertEqual(body.account.connectionId, FixtureData.accountID)
        if path.hasSuffix("manual-grant") {
          XCTAssertEqual(body.authMethod, "api-token")
          XCTAssertEqual(body.values, ["token": "synthetic-token"])
          storedMethod.withLock { $0 = "api-token" }
          return ChatHTTPResponse(body: "{\"connectionId\":\"\(FixtureData.accountID)\"}")
        }
        XCTAssertEqual(body.authMethod, "oauth")
        XCTAssertNil(body.values)
        return ChatHTTPResponse(
          body:
            "{\"authorizationUrl\":\"https://auth.example.invalid/start\",\"oauthAttemptId\":\"\(FixtureData.attemptID)\"}"
        )
      }
      if path.contains("oauth-completions") {
        guard authorized.withLock({ $0 }) else {
          return ChatHTTPResponse(status: 404, body: "{}")
        }
        storedMethod.withLock { $0 = "oauth" }
        return ChatHTTPResponse(body: "{\"connectionId\":\"\(FixtureData.accountID)\"}")
      }
      return try XCTUnwrap(FixtureData.response(request))
    }
    let service = ChatConnectorService(client: fixture.client)
    let store = ConnectorActionStore(
      service: service, didContinue: {}, didFail: { _ in }, pollSleep: clock.sleep)
    defer { store.close() }
    let action = ChatConnectorAction.configuration(
      target: .builtin("slack"), threadID: nil, connectionID: FixtureData.accountID)

    store.activate(action)
    try await waitForBusinessResult { store.active != nil }
    let canceled = try XCTUnwrap(store.active)
    XCTAssertEqual(canceled.methodID, "oauth")
    canceled.methodID = "api-token"
    canceled.values["token"] = "discarded-token"
    store.cancel()
    let unchanged = try await service.account(id: FixtureData.accountID, target: .builtin("slack"))
    XCTAssertEqual(unchanged.authMethod, "oauth")

    store.activate(action)
    try await waitForBusinessResult { store.active != nil }
    let manual = try XCTUnwrap(store.active)
    manual.methodID = "api-token"
    manual.values["token"] = "synthetic-token"
    store.submit()
    try await waitForBusinessResult { store.active == nil }
    let tokenAccount = try await service.account(
      id: FixtureData.accountID, target: .builtin("slack"))
    XCTAssertEqual(tokenAccount.id, FixtureData.accountID)
    XCTAssertEqual(tokenAccount.authMethod, "api-token")
    XCTAssertTrue(tokenAccount.ready)

    store.activate(action)
    try await waitForBusinessResult { store.active != nil }
    let oauth = try XCTUnwrap(store.active)
    XCTAssertEqual(oauth.methodID, "api-token")
    oauth.methodID = "oauth"
    store.submit()
    await fulfillment(of: [scheduled], timeout: 3)
    authorized.withLock { $0 = true }
    clock.advance(.seconds(2))
    try await waitForBusinessResult { store.active == nil }
    let oauthAccount = try await service.account(
      id: FixtureData.accountID, target: .builtin("slack"))
    XCTAssertEqual(oauthAccount.id, FixtureData.accountID)
    XCTAssertEqual(oauthAccount.authMethod, "oauth")
    XCTAssertTrue(oauthAccount.ready)
  }

  func testProviderNoticeRequiresConfirmationBeforeStartingOAuth() async throws {
    let confirmed = Mutex(false)
    let authorizationURL =
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=42&state=notice-state&response_type=code&scope=read&redirect_uri=https%3A%2F%2Fapp.example.invalid%2Fconnectors%2Fgmail%2Fcallback"
    let scheduled = expectation(description: "Confirmed OAuth attempt is waiting")
    let clock = ConnectorPollingClock(didSchedule: { _ in scheduled.fulfill() })
    let fixture = ChatHTTPFixture { request in
      if request.url!.path == "/api/connector-catalog/gmail" {
        return ChatHTTPResponse(
          body: FixtureData.catalog(grantKind: "auth-code", slug: "gmail").replacingOccurrences(
            of: "\"connectNotice\":null",
            with: "\"connectNotice\":\"google-security-warning\""))
      }
      if request.url!.path == "/api/connectors/gmail/oauth/start" {
        XCTAssertTrue(confirmed.withLock { $0 })
        return ChatHTTPResponse(
          body:
            "{\"authorizationUrl\":\"\(authorizationURL)\",\"oauthAttemptId\":\"\(FixtureData.attemptID)\"}"
        )
      }
      return try XCTUnwrap(FixtureData.response(request, connected: false, grantKind: "auth-code"))
    }
    let store = ConnectorActionStore(
      service: ChatConnectorService(client: fixture.client), didContinue: {}, didFail: { _ in },
      providerApplication: UnavailableProviderApplication(), pollSleep: clock.sleep)
    defer { store.close() }
    store.activate(.configuration(target: .builtin("gmail"), threadID: nil))
    try await waitForBusinessResult { store.active?.canSubmit == true }
    confirmed.withLock { $0 = true }
    store.submit()
    await fulfillment(of: [scheduled], timeout: 3)
    XCTAssertEqual(store.active?.session?.oauthAttemptId, FixtureData.attemptID)
  }
}
