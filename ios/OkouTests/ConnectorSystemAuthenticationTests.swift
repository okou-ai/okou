import ChatData
import ChatDataTestSupport
import Synchronization
import XCTest

@testable import Okou

private typealias FixtureData = ConnectorHTTPFixtures

@MainActor
final class ConnectorSystemAuthenticationTests: XCTestCase {
  func testSystemAuthenticationFailureCanRetryAndIgnoresTheRetiredSession() async throws {
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
      service: ChatConnectorService(client: fixture.client),
      didContinue: { continued.withLock { $0 = true } }, didFail: { _ in },
      pollSleep: clock.sleep)
    defer { store.close() }
    store.activate(.configuration(target: .builtin("slack"), threadID: nil))
    try await waitForBusinessResult { store.active != nil }
    store.submit()
    await fulfillment(of: [scheduled[0]], timeout: 3)
    let flow = try XCTUnwrap(store.active)
    let retiredURL = try XCTUnwrap(flow.browserURL)
    store.authenticationFinished(flow: flow, url: retiredURL, error: APIClientError.invalidResponse)
    XCTAssertTrue(flow.canSubmit)
    XCTAssertNotNil(flow.error)
    XCTAssertFalse(continued.withLock { $0 })
    store.submit()
    await fulfillment(of: [scheduled[1]], timeout: 3)
    let retryURL = try XCTUnwrap(flow.browserURL)
    XCTAssertNotEqual(retryURL, retiredURL)
    store.authenticationFinished(flow: flow, url: retiredURL, error: APIClientError.invalidResponse)
    XCTAssertEqual(flow.browserURL, retryURL)
    clock.advance(.seconds(2))
    try await waitForBusinessResult { store.active == nil }
    XCTAssertTrue(connected.withLock { $0 })
    XCTAssertTrue(continued.withLock { $0 })
  }
}
