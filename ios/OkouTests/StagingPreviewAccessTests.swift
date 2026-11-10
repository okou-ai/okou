import Foundation
import XCTest

@testable import Okou

final class StagingPreviewAccessTests: XCTestCase {
  func testPreviewAccessCookieOnlyReachesTheStagingAPI() throws {
    let storage = try XCTUnwrap(URLSessionConfiguration.ephemeral.httpCookieStorage)
    let api = try XCTUnwrap(URL(string: "https://staging-api.vm6.ai"))
    StagingPreviewAccess.configure(apiURL: api, bypass: "qa-fixture", storage: storage)
    let endpoint = api.appendingPathComponent("api/projects")
    let headers = HTTPCookie.requestHeaderFields(with: storage.cookies(for: endpoint) ?? [])
    XCTAssertEqual(headers["Cookie"], "x-vercel-protection-bypass=qa-fixture")

    for origin in [
      "https://informed-calf-6.clerk.accounts.dev/api/projects",
      "https://storage.example.invalid/api/projects",
      "https://api.okou.ai/api/projects",
      "http://staging-api.vm6.ai/api/projects",
      "https://staging-api.vm6.ai/unrelated",
    ] {
      let url = try XCTUnwrap(URL(string: origin))
      XCTAssertTrue(storage.cookies(for: url)?.isEmpty ?? true, origin)
    }

    StagingPreviewAccess.configure(
      apiURL: try XCTUnwrap(URL(string: "https://api.okou.ai")),
      bypass: "qa-fixture", storage: storage)
    XCTAssertTrue(
      storage.cookies(for: try XCTUnwrap(URL(string: "https://api.okou.ai/api/projects")))?
        .isEmpty ?? true)
  }
}
