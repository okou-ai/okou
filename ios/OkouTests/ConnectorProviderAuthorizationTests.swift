import ChatData
import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import Okou

private typealias FixtureData = ConnectorHTTPFixtures

@MainActor
private final class ProviderApplication: ConnectorProviderApplication {
  let dropboxAppKey: String? = "42"
  let opens: Bool
  var openedURL: URL?
  var request: ConnectorProviderRequest?
  private let holdsLaunch: Bool
  private let launchStarted: () -> Void
  private let launchFinished: () -> Void
  private var launch: CheckedContinuation<ConnectorProviderLaunch, Never>?
  init(
    opens: Bool, holdsLaunch: Bool = false,
    launchStarted: @escaping () -> Void = {}, launchFinished: @escaping () -> Void = {}
  ) {
    self.opens = opens
    self.holdsLaunch = holdsLaunch
    self.launchStarted = launchStarted
    self.launchFinished = launchFinished
  }
  func supports(_ target: ChatConnectorTarget) -> Bool { true }
  func authorize(_ request: ConnectorProviderRequest) async throws -> ConnectorProviderLaunch {
    self.request = request
    openedURL = request.appURLs.first
    if holdsLaunch {
      // UIApplication's launch completion can arrive after the provider's URL.
      // This boundary deliberately models an OS callback that ignores Task cancellation.
      defer { launchFinished() }
      return await withCheckedContinuation { continuation in
        launch = continuation
        launchStarted()
      }
    }
    return opens ? .opened : .unavailable
  }
  func finishLaunch() {
    let pending = launch
    launch = nil
    pending?.resume(returning: opens ? .opened : .unavailable)
  }
}

private final class ProviderAuthorizationFixture: Sendable {
  let completed = Mutex(false)
  let starts = Mutex(0)
  let callbacks = Mutex(0)
  let slug: String
  let authorizationURL: String

  init(slug: String = "strava") {
    self.slug = slug
    let endpoints = [
      "strava": "https://www.strava.com/oauth/mobile/authorize",
      "tiktok": "https://www.tiktok.com/v2/auth/authorize/",
      "dropbox": "https://www.dropbox.com/oauth2/authorize",
      "spotify": "https://accounts.spotify.com/authorize"
    ]
    let endpoint = endpoints[slug] ?? "https://accounts.google.com/o/oauth2/v2/auth"
    let callback =
      Self.callback(slug)
      ?? "https://app.example.invalid/connectors/\(slug)/callback"
    var components = URLComponents(string: endpoint)!
    components.queryItems = [
      URLQueryItem(name: "client_id", value: "42"),
      URLQueryItem(name: "client_key", value: "42"),
      URLQueryItem(name: "state", value: "server-state"),
      URLQueryItem(name: "response_type", value: "code"),
      URLQueryItem(name: "scope", value: "read"),
      URLQueryItem(name: "redirect_uri", value: callback),
      URLQueryItem(name: "code_challenge", value: "server-challenge"),
      URLQueryItem(name: "code_challenge_method", value: "S256"),
      URLQueryItem(name: "token_access_type", value: "offline")
    ]
    authorizationURL =
      components.url!.absoluteString
  }

  static func callback(_ slug: String) -> String? {
    switch slug {
    case "tiktok": "https://app.okou.ai/connectors/tiktok/callback"
    case "dropbox": "db-42://2/token"
    default: nil
    }
  }

  func response(_ request: URLRequest) throws -> ChatHTTPResponse {
    let path = request.url!.path
    if path == "/api/connectors/\(slug)/oauth/start" {
      struct Body: Decodable {
        struct Account: Decodable { let intent: String }
        let account: Account
        let nativeAppAuthorization: String?
        let nativeAppClientId: String?
        let callbackTarget: String
      }
      let body = try JSONDecoder().decode(Body.self, from: chatRequestBody(request))
      XCTAssertEqual(body.account.intent, "add")
      let nativeProvider = ["strava", "tiktok", "dropbox"].contains(slug)
      XCTAssertEqual(body.nativeAppAuthorization, nativeProvider ? "ios" : nil)
      XCTAssertEqual(body.nativeAppClientId, slug == "dropbox" ? "42" : nil)
      XCTAssertEqual(body.callbackTarget, "app")
      starts.withLock { $0 += 1 }
      let native: String
      if let callback = Self.callback(slug) {
        native =
          "\"nativeAppAuthorization\":{\"provider\":\"\(slug)\",\"callbackUrl\":\"\(callback)\",\"exchangeUrl\":\"https://app.okou.ai/connectors/\(slug)/callback\"}"
      } else {
        native =
          slug == "strava"
          ? "\"nativeAppAuthorization\":{\"provider\":\"strava\"}"
          : "\"nativeCallbackUrl\":\"https://app.okou.ai/native/connector-authorization?attemptId=\(FixtureData.attemptID)\""
      }
      return ChatHTTPResponse(
        body: """
          {"authorizationUrl":"\(authorizationURL)","oauthAttemptId":"\(FixtureData.attemptID)",\(native)}
          """)
    }
    if path == "/api/connectors/\(slug)/callback" {
      let items = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!
      XCTAssertEqual(items.first { $0.name == "state" }?.value, "server-state")
      XCTAssertEqual(items.first { $0.name == "responseMode" }?.value, "json")
      callbacks.withLock { $0 += 1 }
      if items.contains(where: { $0.name == "error" }) {
        return ChatHTTPResponse(body: "{\"status\":\"error\",\"message\":\"Access denied\"}")
      }
      XCTAssertEqual(items.first { $0.name == "code" }?.value, "provider-code")
      completed.withLock { $0 = true }
      return ChatHTTPResponse(body: "{\"status\":\"success\",\"username\":\"Native user\"}")
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
  func testProviderReturnBeforeLaunchCompletionRetainsItsBackendReceipt() async throws {
    let launched = expectation(description: "OS accepted the launch request")
    let finished = expectation(description: "OS delivered the launch completion")
    let exchanged = expectation(description: "Provider callback exchanged before launch completes")
    let clock = ConnectorPollingClock(didSchedule: { _ in exchanged.fulfill() })
    let provider = ProviderApplication(
      opens: true, holdsLaunch: true,
      launchStarted: { launched.fulfill() }, launchFinished: { finished.fulfill() })
    let responses = ProviderAuthorizationFixture(slug: "tiktok")
    let fixture = ChatHTTPFixture { try responses.response($0) }
    let continued = Mutex(false)
    let store = ConnectorActionStore(
      service: ChatConnectorService(client: fixture.client), graph: makeTestWorkspaceGraph(),
      didContinue: { continued.withLock { $0 = true } },
      didFail: { _ in XCTFail("Canceled launch must not fail the callback") },
      providerApplication: provider, pollSleep: clock.sleep)
    defer {
      provider.finishLaunch()
      store.close()
    }
    store.activate(.configuration(target: .builtin("tiktok"), threadID: nil))
    try await waitForBusinessResult(watching: store) { store.active != nil }
    store.submit()
    await fulfillment(of: [launched], timeout: 3)
    store.receiveProviderReturn(
      URL(
        string:
          "https://app.okou.ai/connectors/tiktok/callback?state=server-state&code=provider-code")!)
    await fulfillment(of: [exchanged], timeout: 3)
    provider.finishLaunch()
    await fulfillment(of: [finished], timeout: 3)
    clock.advance(.seconds(2))
    try await waitForBusinessResult(watching: store) { store.active == nil }
    XCTAssertTrue(continued.withLock { $0 })
    XCTAssertEqual(responses.starts.withLock { $0 }, 1)
    XCTAssertEqual(responses.callbacks.withLock { $0 }, 1)
  }

  func testNativeProvidersExchangeCodesBeforeConfirmingTheExactAccount() async throws {
    for slug in ["tiktok", "dropbox"] {
      let initial = expectation(description: "\(slug) launched")
      let callback = expectation(description: "\(slug) exchanged")
      let schedules = Mutex(0)
      let clock = ConnectorPollingClock(didSchedule: { _ in
        let count = schedules.withLock { value in
          value += 1
          return value
        }
        if count == 1 { initial.fulfill() } else { callback.fulfill() }
      })
      let provider = ProviderApplication(opens: true)
      let responses = ProviderAuthorizationFixture(slug: slug)
      let fixture = ChatHTTPFixture { try responses.response($0) }
      let continued = Mutex(false)
      let store = ConnectorActionStore(
        service: ChatConnectorService(client: fixture.client), graph: makeTestWorkspaceGraph(),
        didContinue: { continued.withLock { $0 = true } },
        didFail: { _ in XCTFail("Unexpected error") },
        providerApplication: provider, pollSleep: clock.sleep)
      defer { store.close() }
      store.activate(.configuration(target: .builtin(slug), threadID: nil))
      try await waitForBusinessResult(watching: store) { store.active != nil }
      store.submit()
      await fulfillment(of: [initial], timeout: 3)
      XCTAssertEqual(provider.request?.provider, slug)
      XCTAssertFalse(continued.withLock { $0 })
      if slug == "tiktok" {
        XCTAssertEqual(
          provider.openedURL?.absoluteString.components(separatedBy: "?").first,
          "https://www.tiktok.com/opensdk/oauth/")
      } else if slug == "dropbox" {
        XCTAssertEqual(
          provider.openedURL?.absoluteString.components(separatedBy: "?").first,
          "dbapi-2://1/connect")
      }
      let base =
        slug == "dropbox" ? "db-42://1/connect" : "https://app.okou.ai/connectors/tiktok/callback"
      let codeParameter = slug == "dropbox" ? "oauth_code" : "code"
      store.receiveProviderReturn(
        URL(string: "\(base)?state=unrelated&\(codeParameter)=provider-code")!)
      store.receiveProviderReturn(
        URL(string: "\(base)?state=server-state&\(codeParameter)=provider-code")!)
      await fulfillment(of: [callback], timeout: 3)
      clock.advance(.seconds(2))
      try await waitForBusinessResult(watching: store) { store.active == nil }
      XCTAssertTrue(continued.withLock { $0 })
      XCTAssertEqual(responses.starts.withLock { $0 }, 1)
      XCTAssertEqual(responses.callbacks.withLock { $0 }, 1)
    }
  }

  func testUnavailableNativeAppsUseTheSameAttemptInTheBrowser() async throws {
    for slug in ["tiktok", "dropbox"] {
      let scheduled = expectation(description: "\(slug) web fallback")
      let clock = ConnectorPollingClock(didSchedule: { _ in scheduled.fulfill() })
      let responses = ProviderAuthorizationFixture(slug: slug)
      let fixture = ChatHTTPFixture { try responses.response($0) }
      let store = ConnectorActionStore(
        service: ChatConnectorService(client: fixture.client), graph: makeTestWorkspaceGraph(),
        didContinue: {}, didFail: { _ in },
        providerApplication: ProviderApplication(opens: false), pollSleep: clock.sleep)
      defer { store.close() }
      store.activate(.configuration(target: .builtin(slug), threadID: nil))
      try await waitForBusinessResult(watching: store) { store.active != nil }
      store.submit()
      await fulfillment(of: [scheduled], timeout: 3)
      XCTAssertEqual(store.active?.browserURL?.absoluteString, responses.authorizationURL)
      XCTAssertEqual(responses.starts.withLock { $0 }, 1)
    }
  }

  func testNativeProviderDenialLeavesRetryAvailableWithoutOpeningTheBrowser() async throws {
    let scheduled = expectation(description: "TikTok launched")
    let clock = ConnectorPollingClock(didSchedule: { _ in scheduled.fulfill() })
    let responses = ProviderAuthorizationFixture(slug: "tiktok")
    let fixture = ChatHTTPFixture { try responses.response($0) }
    let store = ConnectorActionStore(
      service: ChatConnectorService(client: fixture.client), graph: makeTestWorkspaceGraph(),
      didContinue: { XCTFail("Denial cannot connect") }, didFail: { _ in },
      providerApplication: ProviderApplication(opens: true), pollSleep: clock.sleep)
    defer { store.close() }
    store.activate(.configuration(target: .builtin("tiktok"), threadID: nil))
    try await waitForBusinessResult(watching: store) { store.active != nil }
    store.submit()
    await fulfillment(of: [scheduled], timeout: 3)
    let flow = try XCTUnwrap(store.active)
    store.receiveProviderReturn(
      URL(
        string:
          "https://app.okou.ai/connectors/tiktok/callback?state=server-state&error=access_denied")!)
    try await waitForBusinessResult { flow.error != nil }
    XCTAssertNil(flow.browserURL)
    XCTAssertTrue(flow.canSubmit)
    XCTAssertEqual(responses.starts.withLock { $0 }, 1)
  }

  func testDropboxBrowserFallbackReturnsItsCodeToTheServer() async throws {
    let initial = expectation(description: "Dropbox browser opened")
    let exchanged = expectation(description: "Dropbox browser code exchanged")
    let schedules = Mutex(0)
    let clock = ConnectorPollingClock(didSchedule: { _ in
      let count = schedules.withLock { value in
        value += 1
        return value
      }
      (count == 1 ? initial : exchanged).fulfill()
    })
    let responses = ProviderAuthorizationFixture(slug: "dropbox")
    let fixture = ChatHTTPFixture { try responses.response($0) }
    let store = ConnectorActionStore(
      service: ChatConnectorService(client: fixture.client), graph: makeTestWorkspaceGraph(),
      didContinue: {}, didFail: { _ in XCTFail("Unexpected error") },
      providerApplication: ProviderApplication(opens: false), pollSleep: clock.sleep)
    defer { store.close() }
    store.activate(.configuration(target: .builtin("dropbox"), threadID: nil))
    try await waitForBusinessResult(watching: store) { store.active != nil }
    store.submit()
    await fulfillment(of: [initial], timeout: 3)
    let flow = try XCTUnwrap(store.active)
    XCTAssertNotNil(flow.browserURL)
    store.receiveProviderReturn(
      URL(string: "db-42://2/token?state=server-state&code=provider-code")!)
    await fulfillment(of: [exchanged], timeout: 3)
    clock.advance(.seconds(2))
    try await waitForBusinessResult(watching: store) { store.active == nil }
    XCTAssertEqual(responses.starts.withLock { $0 }, 1)
    XCTAssertEqual(responses.callbacks.withLock { $0 }, 1)
  }

  func testDropboxAppCancellationChecksForCompletionBeforeAllowingRetry() async throws {
    let initial = expectation(description: "Dropbox app opened")
    let returned = expectation(description: "Dropbox cancellation checked")
    let schedules = Mutex(0)
    let clock = ConnectorPollingClock(didSchedule: { _ in
      let count = schedules.withLock { value in
        value += 1
        return value
      }
      (count == 1 ? initial : returned).fulfill()
    })
    let responses = ProviderAuthorizationFixture(slug: "dropbox")
    let fixture = ChatHTTPFixture { try responses.response($0) }
    let store = ConnectorActionStore(
      service: ChatConnectorService(client: fixture.client), graph: makeTestWorkspaceGraph(),
      didContinue: { XCTFail("Cancellation cannot connect") }, didFail: { _ in },
      providerApplication: ProviderApplication(opens: true), pollSleep: clock.sleep)
    defer { store.close() }
    store.activate(.configuration(target: .builtin("dropbox"), threadID: nil))
    try await waitForBusinessResult(watching: store) { store.active != nil }
    store.submit()
    await fulfillment(of: [initial], timeout: 3)
    let flow = try XCTUnwrap(store.active)
    store.authorizationSceneChanged(isActive: false, isBackground: true)
    store.receiveProviderReturn(URL(string: "db-42://1/cancel")!)
    await fulfillment(of: [returned], timeout: 3)
    clock.advance(.seconds(2))
    try await waitForBusinessResult { flow.session == nil }
    XCTAssertNil(flow.browserURL)
    XCTAssertTrue(flow.canSubmit)
    XCTAssertEqual(responses.callbacks.withLock { $0 }, 0)
    XCTAssertEqual(responses.starts.withLock { $0 }, 1)
  }

  func testWebProvidersUseTheBrowserAndConfirmTheExactBackendAccount() async throws {
    for slug in ["gmail", "spotify"] {
      let scheduled = expectation(description: "\(slug) browser authorization polling")
      let clock = ConnectorPollingClock(didSchedule: { _ in scheduled.fulfill() })
      let provider = ProviderApplication(opens: true)
      let responses = ProviderAuthorizationFixture(slug: slug)
      let fixture = ChatHTTPFixture { try responses.response($0) }
      let continued = Mutex(false)
      let store = ConnectorActionStore(
        service: ChatConnectorService(client: fixture.client), graph: makeTestWorkspaceGraph(),
        didContinue: { continued.withLock { $0 = true } }, didFail: { _ in },
        providerApplication: provider, pollSleep: clock.sleep)
      defer { store.close() }
      store.activate(.configuration(target: .builtin(slug), threadID: nil))
      await fulfillment(of: [scheduled], timeout: 3)
      let flow = try XCTUnwrap(store.active)
      XCTAssertNil(provider.request)
      let browser = try XCTUnwrap(flow.browserURL)
      XCTAssertEqual(browser.absoluteString, responses.authorizationURL)
      responses.completed.withLock { $0 = true }
      store.receiveProviderReturn(try XCTUnwrap(flow.session?.nativeCallbackUrl))
      clock.advance(.seconds(2))
      try await waitForBusinessResult(watching: store) { store.active == nil }
      XCTAssertTrue(continued.withLock { $0 })
      XCTAssertEqual(responses.starts.withLock { $0 }, 1)
    }
  }

  func testGoogleBrowserReturnWithoutCallbackChecksThePendingAttemptBeforeRetry() async throws {
    let scheduled = expectation(description: "Google browser authorization polling")
    let clock = ConnectorPollingClock(didSchedule: { _ in scheduled.fulfill() })
    let responses = ProviderAuthorizationFixture(slug: "gmail")
    let fixture = ChatHTTPFixture { try responses.response($0) }
    let store = ConnectorActionStore(
      service: ChatConnectorService(client: fixture.client), graph: makeTestWorkspaceGraph(),
      didContinue: { XCTFail("Denial cannot continue") }, didFail: { _ in },
      providerApplication: ProviderApplication(opens: true), pollSleep: clock.sleep)
    defer { store.close() }
    let action = ChatConnectorAction.configuration(target: .builtin("gmail"), threadID: nil)
    store.activate(action)
    await fulfillment(of: [scheduled], timeout: 3)
    let flow = try XCTUnwrap(store.active)
    store.authorizationSceneChanged(isActive: false, isBackground: true)
    store.authorizationSceneChanged(isActive: true, isBackground: false)
    clock.advance(.seconds(2))
    try await waitForBusinessResult(watching: store) { store.active == nil }
    XCTAssertNil(flow.browserURL)
    XCTAssertNotNil(store.notices[action.id])
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
      service: ChatConnectorService(client: fixture.client), graph: makeTestWorkspaceGraph(),
      didContinue: { continued.withLock { $0 = true } }, didFail: { _ in },
      providerApplication: provider, pollSleep: clock.sleep)
    defer { store.close() }
    store.activate(.configuration(target: .builtin("strava"), threadID: nil))
    try await waitForBusinessResult(watching: store) { store.active != nil }
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
    store.authorizationSceneChanged(isActive: false, isBackground: true)
    responses.completed.withLock { $0 = true }
    store.receiveProviderReturn(
      URL(string: "ai.okou.ios://connector-authorization/\(FixtureData.attemptID)")!)
    await fulfillment(of: [returned], timeout: 3)
    clock.advance(.seconds(2))
    try await waitForBusinessResult(watching: store) { store.active == nil }
    XCTAssertTrue(continued.withLock { $0 })
    XCTAssertEqual(responses.starts.withLock { $0 }, 1)
  }

  func testDefinitiveLaunchFailureUsesSameAttemptInExternalBrowser() async throws {
    let scheduled = expectation(description: "Web fallback polling")
    let clock = ConnectorPollingClock(didSchedule: { _ in scheduled.fulfill() })
    let provider = ProviderApplication(opens: false)
    let responses = ProviderAuthorizationFixture()
    let fixture = ChatHTTPFixture { try responses.response($0) }
    let store = ConnectorActionStore(
      service: ChatConnectorService(client: fixture.client), graph: makeTestWorkspaceGraph(),
      didContinue: {}, didFail: { _ in }, providerApplication: provider, pollSleep: clock.sleep)
    defer { store.close() }
    store.activate(.configuration(target: .builtin("strava"), threadID: nil))
    try await waitForBusinessResult(watching: store) { store.active != nil }
    store.submit()
    await fulfillment(of: [scheduled], timeout: 3)
    let flow = try XCTUnwrap(store.active)
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
      service: ChatConnectorService(client: fixture.client), graph: makeTestWorkspaceGraph(),
      didContinue: { XCTFail("Denial cannot continue") }, didFail: { _ in },
      providerApplication: ProviderApplication(opens: true), pollSleep: clock.sleep)
    defer { store.close() }
    store.activate(.configuration(target: .builtin("strava"), threadID: nil))
    try await waitForBusinessResult(watching: store) { store.active != nil }
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
