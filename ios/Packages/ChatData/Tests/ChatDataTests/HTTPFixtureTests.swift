import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

final class HTTPFixtureTests: XCTestCase {
  func testUnexpectedOriginReportsFailureInsteadOfReachingTheNetwork() async throws {
    let failures = Mutex<[String]>([])
    let fixture = ChatHTTPFixture(
      onUnhandledRequest: { value in
        failures.withLock { $0.append(value) }
      },
      handler: { _ in
        XCTFail("A foreign origin must not reach the configured API handler")
        return ChatHTTPResponse(body: "{}")
      })
    do {
      _ = try await fixture.session.data(
        from: URL(string: "https://unhandled.example.invalid/api/me")!)
      XCTFail("Unregistered origins must fail")
    } catch let error as URLError { XCTAssertEqual(error.code, .unsupportedURL) }
    XCTAssertTrue(
      failures.withLock {
        $0.contains { $0.contains("GET https://unhandled.example.invalid/api/me") }
      })
  }

  func testAnUnhandledRouteIsReportedEvenWhenTheCallerCatchesItsTransportError() async throws {
    let failures = Mutex<[String]>([])
    let fixture = ChatHTTPFixture(
      onUnhandledRequest: { value in
        failures.withLock { $0.append(value) }
      },
      handler: { _ in
        throw URLError(.unsupportedURL)
      })
    do {
      _ = try await fixture.session.data(from: fixture.baseURL.appending(path: "missing"))
      XCTFail("An unregistered route must fail")
    } catch let error as URLError { XCTAssertEqual(error.code, .unsupportedURL) }
    XCTAssertTrue(failures.withLock { $0.contains { $0.contains("/missing") } })
  }

  func testFixtureOwnershipDoesNotChangeTheProductionRequestHeaders() async throws {
    let fixture = ChatHTTPFixture { request in
      XCTAssertNil(request.value(forHTTPHeaderField: "X-Okou-Test-Fixture"))
      XCTAssertEqual(request.httpMethod, "POST")
      XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer fixture")
      return ChatHTTPResponse(body: "accepted")
    }
    var request = URLRequest(url: fixture.baseURL.appending(path: "message"))
    request.httpMethod = "POST"
    request.setValue("Bearer fixture", forHTTPHeaderField: "Authorization")
    let (bytes, _) = try await fixture.session.data(for: request)
    XCTAssertEqual(String(decoding: bytes, as: UTF8.self), "accepted")
  }
}
