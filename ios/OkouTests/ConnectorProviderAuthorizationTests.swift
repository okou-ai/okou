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
  var requiresUniversalLink = false
  init(opens: Bool) { self.opens = opens }
  func open(_ url: URL, universalLinksOnly: Bool) async -> Bool {
    openedURL = url
    requiresUniversalLink = universalLinksOnly
    return opens
  }
}

private final class ProviderAuthorizationFixture: Sendable {
  let completed = Mutex(false)
  let starts = Mutex(0)
  let slug: String
  let authorizationURL: String

  init(slug: String = "strava") {
    self.slug = slug
    let endpoint =
      slug == "strava"
      ? "https://www.strava.com/oauth/mobile/authorize"
      : "https://accounts.google.com/o/oauth2/v2/auth"
    authorizationURL =
      "\(endpoint)?client_id=42&state=server-state&response_type=code&scope=read&redirect_uri=https%3A%2F%2Fapp.example.invalid%2Fconnectors%2F\(slug)%2Fcallback"
  }

  func response(_ request: URLRequest) throws -> ChatHTTPResponse {
    let path = request.url!.path
    if path == "/api/connectors/\(slug)/oauth/start" {
      struct Body: Decodable {
        struct Account: Decodable { let intent: String }
        let account: Account
        let nativeAppAuthorization: String?
        let callbackTarget: String
      }
      let body = try JSONDecoder().decode(Body.self, from: chatRequestBody(request))
      XCTAssertEqual(body.account.intent, "add")
      XCTAssertEqual(body.nativeAppAuthorization, slug == "strava" ? "ios" : nil)
      XCTAssertEqual(body.callbackTarget, "app")
      starts.withLock { $0 += 1 }
      let native =
        slug == "strava"
        ? "\"nativeAppAuthorization\":{\"provider\":\"strava\"}"
        : "\"nativeCallbackUrl\":\"https://app.okou.ai/native/connector-authorization?attemptId=\(FixtureData.attemptID)\""
      return ChatHTTPResponse(
        body: """
          {"authorizationUrl":"\(authorizationURL)","oauthAttemptId":"\(FixtureData.attemptID)",\(native)}
          """)
    }
    if path.contains("oauth-completions") {
      XCTAssertEqual(
        URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first {
          $0.name == "connectorSlug"
        }?.value, slug)
      return completed.withLock { $0 }
        ? ChatHTTPResponse(body: "{\"connectionId\":\"\(FixtureData.accountID)\"}")
        : ChatHTTPResponse(status: 404, body: "{\"error\":{\"message\":\"Pending\"}}")
    }
    if path == "/api/connector-catalog/\(slug)" {
      return ChatHTTPResponse(body: FixtureData.catalog(grantKind: "auth-code", slug: slug))
    }
    if path == "/api/connector-accounts/\(FixtureData.accountID)" {
      return ChatHTTPResponse(
        body: FixtureData.account().replacingOccurrences(of: "slack", with: slug))
    }
    throw URLError(.unsupportedURL)
  }
}

@MainActor
final class ConnectorProviderAuthorizationTests: XCTestCase {
  func testGoogleConnectorsTryTheExactUniversalLinkAndConfirmTheirBackendAccount() async throws {
    for slug in [
      "gmail", "google-ads", "google-analytics", "google-calendar", "google-cloud",
      "google-contacts", "google-docs", "google-drive", "google-forms", "google-maps",
      "google-meet", "google-play", "google-search-console", "google-sheets", "youtube"
    ] {
      let initial = expectation(description: "\(slug) app authorization polling")
      let returned = expectation(description: "\(slug) return confirmation polling")
      let schedules = Mutex(0)
      let clock = ConnectorPollingClock(didSchedule: { _ in
        let count = schedules.withLock { value in
          value += 1
          return value
        }
        (count == 1 ? initial : returned).fulfill()
      })
      let provider = ProviderApplication(opens: true)
      let responses = ProviderAuthorizationFixture(slug: slug)
      let fixture = ChatHTTPFixture { try responses.response($0) }
      let continued = Mutex(false)
      let store = ConnectorActionStore(
        service: ChatConnectorService(client: fixture.client),
        didContinue: { continued.withLock { $0 = true } }, didFail: { _ in },
        providerApplication: provider, pollSleep: clock.sleep)
      defer { store.close() }
      store.activate(.configuration(target: .builtin(slug), threadID: nil))
      try await waitForBusinessResult { store.active != nil }
      store.submit()
      await fulfillment(of: [initial], timeout: 3)
      XCTAssertTrue(provider.requiresUniversalLink)
      XCTAssertEqual(provider.openedURL?.absoluteString, responses.authorizationURL)
      XCTAssertNil(store.active?.browserURL)
      XCTAssertFalse(continued.withLock { $0 })
      store.providerSceneActive(false)
      responses.completed.withLock { $0 = true }
      store.receiveProviderReturn(try XCTUnwrap(store.active?.session?.nativeCallbackUrl))
      await fulfillment(of: [returned], timeout: 3)
      clock.advance(.seconds(2))
      try await waitForBusinessResult { store.active == nil }
      XCTAssertTrue(continued.withLock { $0 })
      XCTAssertEqual(responses.starts.withLock { $0 }, 1)
    }
  }

  func testGoogleUniversalLinkFailureCompletesTheSameGrantInTheSystemBrowser() async throws {
    let scheduled = expectation(description: "Google browser authorization polling")
    let clock = ConnectorPollingClock(didSchedule: { _ in scheduled.fulfill() })
    let provider = ProviderApplication(opens: false)
    let responses = ProviderAuthorizationFixture(slug: "google-docs")
    let fixture = ChatHTTPFixture { try responses.response($0) }
    let continued = Mutex(false)
    let store = ConnectorActionStore(
      service: ChatConnectorService(client: fixture.client),
      didContinue: { continued.withLock { $0 = true } }, didFail: { _ in },
      providerApplication: provider, pollSleep: clock.sleep)
    defer { store.close() }
    store.activate(.configuration(target: .builtin("google-docs"), threadID: nil))
    try await waitForBusinessResult { store.active != nil }
    store.submit()
    await fulfillment(of: [scheduled], timeout: 3)
    let flow = try XCTUnwrap(store.active)
    let browser = try XCTUnwrap(flow.browserURL)
    XCTAssertTrue(provider.requiresUniversalLink)
    XCTAssertTrue(flow.usesSystemAuthenticationSession)
    XCTAssertEqual(browser, provider.openedURL)
    XCTAssertEqual(browser.absoluteString, responses.authorizationURL)
    responses.completed.withLock { $0 = true }
    store.authenticationFinished(
      flow: flow, url: browser, callbackURL: flow.session?.nativeCallbackUrl, error: nil)
    clock.advance(.seconds(2))
    try await waitForBusinessResult { store.active == nil }
    XCTAssertTrue(continued.withLock { $0 })
    XCTAssertEqual(responses.starts.withLock { $0 }, 1)
  }

  func testGoogleAppDenialDoesNotStartAnotherBrowserAuthorization() async throws {
    let scheduled = expectation(description: "Google app authorization polling")
    let clock = ConnectorPollingClock(didSchedule: { _ in scheduled.fulfill() })
    let responses = ProviderAuthorizationFixture(slug: "gmail")
    let fixture = ChatHTTPFixture { try responses.response($0) }
    let store = ConnectorActionStore(
      service: ChatConnectorService(client: fixture.client),
      didContinue: { XCTFail("Denial cannot continue") }, didFail: { _ in },
      providerApplication: ProviderApplication(opens: true), pollSleep: clock.sleep)
    defer { store.close() }
    store.activate(.configuration(target: .builtin("gmail"), threadID: nil))
    try await waitForBusinessResult { store.active != nil }
    store.submit()
    await fulfillment(of: [scheduled], timeout: 3)
    let flow = try XCTUnwrap(store.active)
    store.receiveProviderReturn(try XCTUnwrap(flow.session?.nativeCallbackUrl))
    clock.advance(.seconds(2))
    try await waitForBusinessResult { flow.session == nil }
    XCTAssertNil(flow.browserURL)
    XCTAssertTrue(flow.canSubmit)
    XCTAssertNotNil(flow.notice)
    XCTAssertEqual(responses.starts.withLock { $0 }, 1)
  }

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
    let responses = ProviderAuthorizationFixture()
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
    XCTAssertFalse(provider.requiresUniversalLink)
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
    let responses = ProviderAuthorizationFixture()
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
    let responses = ProviderAuthorizationFixture()
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
