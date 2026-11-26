import ChatData
import ChatDataTestSupport
import Synchronization
import XCTest

@testable import Okou

private typealias FixtureData = ConnectorHTTPFixtures

private let githubAuthorizationCatalog = """
  {"connector":{"slug":"github","label":"GitHub","description":"Review repositories","connectNotice":null,"authMethods":[
    {"id":"oauth","label":"OAuth","grantKind":"auth-code","manualFields":[],"startOptions":[]}
  ]}}
  """

@MainActor
final class ConnectorExternalBrowserTests: XCTestCase {
  func testExactHttpsReconnectStartsDirectlyAndRequiresItsBackendReceipt() async throws {
    let scheduled = (1...2).map { expectation(description: "Attempt \($0) is waiting") }
    let starts = Mutex(0)
    let sleeps = Mutex(0)
    let connected = Mutex(false)
    let continued = Mutex(false)
    let clock = ConnectorPollingClock(didSchedule: { _ in
      let index = sleeps.withLock { value in
        defer { value += 1 }
        return value
      }
      guard scheduled.indices.contains(index) else { return XCTFail("Unexpected poll") }
      scheduled[index].fulfill()
    })
    let fixture = ChatHTTPFixture { request in
      let path = request.url!.path
      let account = FixtureData.account().replacingOccurrences(of: "slack", with: "github")
      if path == "/api/connector-catalog/github" {
        return ChatHTTPResponse(body: githubAuthorizationCatalog)
      }
      if path == "/api/connector-accounts/connections" {
        let account = connected.withLock { $0 } ? account : "null"
        return ChatHTTPResponse(
          body:
            "{\"connections\":\(account == "null" ? "[]" : "[\(account)]"),\"nextCursor\":null,\"defaultConnection\":\(account)}"
        )
      }
      if path == "/api/connector-accounts/\(FixtureData.accountID)" {
        return ChatHTTPResponse(body: account)
      }
      if path == "/api/connectors/github/oauth/start" {
        struct Body: Decodable {
          struct Account: Decodable {
            let intent: String
            let connectionId: String
          }
          let account: Account
        }
        let body = try JSONDecoder().decode(Body.self, from: chatRequestBody(request))
        XCTAssertEqual(body.account.intent, "reconnect")
        XCTAssertEqual(body.account.connectionId, FixtureData.accountID)
        let index = starts.withLock { value in
          value += 1
          return value
        }
        let id = index == 1 ? FixtureData.attemptID : FixtureData.siblingID
        return ChatHTTPResponse(
          body:
            "{\"authorizationUrl\":\"https://github.com/login/oauth/authorize?attempt=\(index)\",\"oauthAttemptId\":\"\(id)\",\"nativeCallbackUrl\":\"https://app.okou.ai/native/connector-authorization?attemptId=\(id)\"}"
        )
      }
      if path.contains("oauth-completions") {
        return connected.withLock { $0 }
          ? ChatHTTPResponse(body: "{\"connectionId\":\"\(FixtureData.accountID)\"}")
          : ChatHTTPResponse(status: 404, body: "{}")
      }
      throw APIClientError.invalidResponse
    }
    let store = ConnectorActionStore(
      service: ChatConnectorService(client: fixture.client), graph: makeTestWorkspaceGraph(),
      didContinue: { continued.withLock { $0 = true } }, didFail: { _ in },
      pollSleep: clock.sleep)
    defer { store.close() }
    store.activate(
      .configuration(target: .builtin("github"), threadID: nil, connectionID: FixtureData.accountID)
    )
    await fulfillment(of: [scheduled[0]], timeout: 3)
    let flow = try XCTUnwrap(store.active)
    let firstReturn = try XCTUnwrap(flow.session?.nativeCallbackUrl)
    let firstBrowser = try XCTUnwrap(flow.browserURL)
    store.receiveProviderReturn(
      try XCTUnwrap(
        URL(
          string:
            "https://evil.invalid/native/connector-authorization?attemptId=\(FixtureData.attemptID)"
        )))
    XCTAssertEqual(flow.browserURL, firstBrowser)
    store.receiveProviderReturn(firstReturn)
    XCTAssertNil(flow.browserURL)
    XCTAssertNotNil(flow.session)
    clock.advance(.seconds(2))
    try await waitForBusinessResult(watching: store) { store.active == nil }
    XCTAssertFalse(continued.withLock { $0 })

    store.activate(
      .configuration(target: .builtin("github"), threadID: nil, connectionID: FixtureData.accountID)
    )
    await fulfillment(of: [scheduled[1]], timeout: 3)
    let nextFlow = try XCTUnwrap(store.active)
    let nextBrowser = try XCTUnwrap(nextFlow.browserURL)
    store.receiveProviderReturn(firstReturn)
    XCTAssertEqual(nextFlow.browserURL, nextBrowser)
    let nextReturn = try XCTUnwrap(nextFlow.session?.nativeCallbackUrl)
    connected.withLock { $0 = true }
    store.receiveProviderReturn(nextReturn)
    clock.advance(.seconds(2))
    try await waitForBusinessResult(watching: store) { store.active == nil }
    XCTAssertTrue(continued.withLock { $0 })
  }

  func testExternalBrowserLaunchFailureCanRetryAndIgnoresTheRetiredAttempt() async throws {
    let scheduled = (1...2).map { expectation(description: "Authorization \($0) polling started") }
    let sleeps = Mutex(0)
    let clock = ConnectorPollingClock(didSchedule: { _ in
      let index = sleeps.withLock { value in
        defer { value += 1 }
        return value
      }
      guard scheduled.indices.contains(index) else { return XCTFail("Unexpected poll") }
      scheduled[index].fulfill()
    })
    let attempts = Mutex(0)
    let connected = Mutex(false)
    let continued = Mutex(false)
    let fixture = ChatHTTPFixture { request in
      if request.url!.path == "/api/connectors/slack/oauth/start" {
        let index = attempts.withLock { value in
          value += 1
          return value
        }
        return ChatHTTPResponse(
          body:
            "{\"authorizationUrl\":\"https://auth.example.invalid/start?attempt=\(index)\",\"oauthAttemptId\":\"\(FixtureData.attemptID)\"}"
        )
      }
      if request.url!.path.contains("oauth-completions") {
        connected.withLock { $0 = true }
        return ChatHTTPResponse(body: "{\"connectionId\":\"\(FixtureData.accountID)\"}")
      }
      return try XCTUnwrap(
        FixtureData.response(request, connected: connected.withLock { $0 }, grantKind: "auth-code"))
    }
    let store = ConnectorActionStore(
      service: ChatConnectorService(client: fixture.client), graph: makeTestWorkspaceGraph(),
      didContinue: { continued.withLock { $0 = true } }, didFail: { _ in },
      pollSleep: clock.sleep)
    defer { store.close() }
    store.activate(.configuration(target: .builtin("slack"), threadID: nil))
    await fulfillment(of: [scheduled[0]], timeout: 3)
    let flow = try XCTUnwrap(store.active)
    let retiredURL = try XCTUnwrap(flow.browserURL)
    store.browserOpenFailed(flow: flow, url: retiredURL)
    XCTAssertTrue(flow.canSubmit)
    XCTAssertNotNil(flow.error)
    XCTAssertFalse(continued.withLock { $0 })
    store.submit()
    await fulfillment(of: [scheduled[1]], timeout: 3)
    let retryURL = try XCTUnwrap(flow.browserURL)
    XCTAssertNotEqual(retryURL, retiredURL)
    store.browserOpenFailed(flow: flow, url: retiredURL)
    XCTAssertEqual(flow.browserURL, retryURL)
    clock.advance(.seconds(2))
    try await waitForBusinessResult(watching: store) { store.active == nil }
    XCTAssertTrue(connected.withLock { $0 })
    XCTAssertTrue(continued.withLock { $0 })
  }
}
