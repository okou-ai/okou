import ChatDataTestSupport
import Foundation
import XCTest

@testable import Okou

@MainActor
final class AuthenticationStartupTests: XCTestCase {
  func testUnexpectedAPIRequestFailsAtTheHTTPBoundary() async throws {
    let fixture = try AuthenticationHTTPFixture()
    addTeardownBlock { await fixture.close() }
    let url = fixture.api.baseURL.appending(path: "api/unhandled-startup-request")
    XCTExpectFailure(
      "An unconfigured startup endpoint must fail with the request URL",
      issueMatcher: { @Sendable issue in
        issue.compactDescription.contains("Unhandled fixture request: GET \(url)")
      })
    do {
      _ = try await fixture.api.session.data(from: url)
      XCTFail("An unconfigured startup request must be rejected")
    } catch let error as URLError {
      XCTAssertEqual(error.code, .unsupportedURL)
    }
  }

  func testUnexpectedIdentityRequestReportsFailureBeforeReturningItsTransportError() async throws {
    let fixture = try AuthenticationHTTPFixture()
    addTeardownBlock { await fixture.close() }
    let request = URLRequest(url: URL(string: "http://127.0.0.1/v1/unconfigured-sdk-route")!)
    XCTExpectFailure(
      "An SDK fixture omission must fail even if its transport error is caught",
      issueMatcher: { @Sendable issue in
        issue.compactDescription.contains("Unhandled Clerk HTTP request: GET")
          && issue.compactDescription.contains("/v1/unconfigured-sdk-route")
      })
    do {
      _ = try await fixture.response(request)
      XCTFail("An unconfigured identity request must be rejected")
    } catch let error as URLError {
      XCTAssertEqual(error.code, .unsupportedURL)
    }
  }
}
