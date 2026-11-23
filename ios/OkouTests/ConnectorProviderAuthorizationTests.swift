import ChatData
import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import Okou

private typealias FixtureData = ConnectorHTTPFixtures

@MainActor
private final class ProviderApplication: ConnectorProviderApplication {
  let opens: Bool
  var openedURL: URL?
  init(opens: Bool) { self.opens = opens }
  func open(_ url: URL) async -> Bool {
    openedURL = url
    return opens
  }
}

private final class StravaAuthorizationFixture: Sendable {
  let completed = Mutex(false)
  let starts = Mutex(0)

  func response(_ request: URLRequest) throws -> ChatHTTPResponse {
    let path = request.url!.path
    if path == "/api/feature-switches" {
      return ChatHTTPResponse(
        body: "{\"effectiveSwitches\":{\"iosConnectorAppAuthorization\":true}}")
    }
    if path == "/api/connectors/strava/oauth/start" {
      struct Body: Decodable {
        struct Account: Decodable { let intent: String }
        let account: Account
        let nativeAppAuthorization: String
        let callbackTarget: String
      }
      let body = try JSONDecoder().decode(Body.self, from: chatRequestBody(request))
      XCTAssertEqual(body.account.intent, "add")
      XCTAssertEqual(body.nativeAppAuthorization, "ios")
      XCTAssertEqual(body.callbackTarget, "app")
      starts.withLock { $0 += 1 }
      return ChatHTTPResponse(
        body: """
          {"authorizationUrl":"https://www.strava.com/oauth/mobile/authorize?client_id=42&state=server-state&response_type=code&scope=read&redirect_uri=https%3A%2F%2Fapp.example.invalid%2Fconnectors%2Fstrava%2Fcallback","oauthAttemptId":"\(FixtureData.attemptID)","nativeAppAuthorization":{"provider":"strava"}}
          """)
    }
    if path.contains("oauth-completions") {
      XCTAssertEqual(connectorQuery("connectorSlug", in: request), "strava")
      return completed.withLock { $0 }
        ? ChatHTTPResponse(body: "{\"connectionId\":\"\(FixtureData.accountID)\"}")
        : ChatHTTPResponse(status: 404, body: "{\"error\":{\"message\":\"Pending\"}}")
    }
    if path == "/api/connector-catalog/strava" {
      return ChatHTTPResponse(body: FixtureData.catalog(grantKind: "auth-code", slug: "strava"))
    }
    if path == "/api/connector-accounts/\(FixtureData.accountID)" {
      return ChatHTTPResponse(
        body: FixtureData.account().replacingOccurrences(of: "slack", with: "strava"))
    }
    throw URLError(.unsupportedURL)
  }
}

@MainActor
final class ConnectorProviderAuthorizationTests: XCTestCase {
  func testInstalledProviderReturnsToExactBackendConfirmation() async throws {
    let initial = expectation(description: "App authorization polling")
    let returned = expectation(description: "Return confirmation polling")
    let schedules = Mutex(0)
    let clock = ConnectorPollingClock(didSchedule: { _ in
      let count = schedules.withLock { value in
        value += 1
        return value
      }
      (count == 1 ? initial : returned).fulfill()
    })
    let provider = ProviderApplication(opens: true)
    let responses = StravaAuthorizationFixture()
    let fixture = ChatHTTPFixture { try responses.response($0) }
    let continued = Mutex(false)
    let store = ConnectorActionStore(
      service: ChatConnectorService(client: fixture.client),
      didContinue: { continued.withLock { $0 = true } }, didFail: { _ in },
      providerApplication: provider, pollSleep: clock.sleep)
    defer { store.close() }
    store.activate(.configuration(target: .builtin("strava"), threadID: nil))
    try await waitForBusinessResult { store.active != nil }
    store.submit()
    await fulfillment(of: [initial], timeout: 3)
    XCTAssertNil(store.active?.browserURL)
    let launched = try XCTUnwrap(provider.openedURL)
    XCTAssertEqual(launched.scheme, "strava")
    XCTAssertEqual(launched.host, "oauth")
    XCTAssertEqual(launched.path, "/mobile/authorize")
    XCTAssertEqual(
      URLComponents(url: launched, resolvingAgainstBaseURL: false)?.queryItems?.first {
        $0.name == "state"
      }?.value, "server-state")
    XCTAssertFalse(continued.withLock { $0 })
    store.providerSceneActive(false)
    responses.completed.withLock { $0 = true }
    store.receiveProviderReturn(
      URL(string: "ai.okou.ios://connector-authorization/\(FixtureData.attemptID)")!)
    await fulfillment(of: [returned], timeout: 3)
    clock.advance(.seconds(2))
    try await waitForBusinessResult { store.active == nil }
    XCTAssertTrue(continued.withLock { $0 })
    XCTAssertEqual(responses.starts.withLock { $0 }, 1)
  }

  func testDefinitiveLaunchFailureUsesSameAttemptInSystemBrowser() async throws {
    let scheduled = expectation(description: "Web fallback polling")
    let clock = ConnectorPollingClock(didSchedule: { _ in scheduled.fulfill() })
    let provider = ProviderApplication(opens: false)
    let responses = StravaAuthorizationFixture()
    let fixture = ChatHTTPFixture { try responses.response($0) }
    let store = ConnectorActionStore(
      service: ChatConnectorService(client: fixture.client),
      didContinue: {}, didFail: { _ in }, providerApplication: provider, pollSleep: clock.sleep)
    defer { store.close() }
    store.activate(.configuration(target: .builtin("strava"), threadID: nil))
    try await waitForBusinessResult { store.active != nil }
    store.submit()
    await fulfillment(of: [scheduled], timeout: 3)
    let flow = try XCTUnwrap(store.active)
    XCTAssertTrue(flow.usesSystemAuthenticationSession)
    XCTAssertFalse(flow.usesProviderApplication)
    let webURL = try XCTUnwrap(flow.browserURL)
    XCTAssertEqual(webURL.scheme, "https")
    XCTAssertEqual(webURL.host, "www.strava.com")
    store.receiveProviderReturn(
      URL(string: "ai.okou.ios://connector-authorization/\(FixtureData.attemptID)")!)
    XCTAssertNil(flow.browserURL)
    clock.advance(.seconds(2))
    try await waitForBusinessResult { flow.session == nil }
    XCTAssertTrue(flow.canSubmit)
    XCTAssertEqual(responses.starts.withLock { $0 }, 1)
  }

  func testDeniedAppReturnDoesNotStartWebAuthorizationAndIgnoresAnUnrelatedReturn() async throws {
    let initial = expectation(description: "App authorization polling")
    let clock = ConnectorPollingClock(didSchedule: { _ in initial.fulfill() })
    let responses = StravaAuthorizationFixture()
    let fixture = ChatHTTPFixture { try responses.response($0) }
    let store = ConnectorActionStore(
      service: ChatConnectorService(client: fixture.client),
      didContinue: { XCTFail("Denial cannot continue") }, didFail: { _ in },
      providerApplication: ProviderApplication(opens: true), pollSleep: clock.sleep)
    defer { store.close() }
    store.activate(.configuration(target: .builtin("strava"), threadID: nil))
    try await waitForBusinessResult { store.active != nil }
    store.submit()
    await fulfillment(of: [initial], timeout: 3)
    let flow = try XCTUnwrap(store.active)
    store.receiveProviderReturn(
      URL(string: "ai.okou.ios://connector-authorization/\(FixtureData.siblingID)")!)
    store.receiveProviderReturn(
      URL(string: "ai.okou.ios://connector-authorization/\(FixtureData.attemptID)")!)
    clock.advance(.seconds(2))
    try await waitForBusinessResult { flow.session == nil }
    XCTAssertNil(flow.browserURL)
    XCTAssertTrue(flow.canSubmit)
    XCTAssertNotNil(flow.notice)
    XCTAssertEqual(responses.starts.withLock { $0 }, 1)
  }
}
