import ChatDataTestSupport
import Foundation
import XCTest

@MainActor
final class ChatHTTPFixtureTests: XCTestCase {
  func testUnknownOriginIsRejectedByTheFixtureWithoutDNSFallback() async throws {
    let fixture = ChatHTTPFixture { _ in
      XCTFail("An unknown origin must not reach a different fixture's handler")
      return ChatHTTPResponse(body: "{}")
    }
    for scheme in ["https", "http"] {
      let url = try XCTUnwrap(
        URL(string: "\(scheme)://unregistered-\(UUID().uuidString).example.invalid"))
      do {
        _ = try await fixture.session.data(from: url)
        XCTFail("An unregistered HTTP origin must be rejected")
      } catch let error as URLError {
        XCTAssertEqual(error.code, .unsupportedURL)
        XCTAssertTrue(error.localizedDescription.contains(url.absoluteString))
      }
    }
  }

  func testFixtureSessionCanReadFilesFromItsLoopbackServer() async throws {
    let body = Data("Fixture-owned file".utf8)
    let server = try ChatFileHTTPServer { _ in .init(body: body) }
    let origin = try await server.start()
    defer { server.stop() }
    let fixture = ChatHTTPFixture { _ in
      XCTFail("Loopback file requests belong to the real fixture server")
      return ChatHTTPResponse(body: "{}")
    }
    let (data, response) = try await fixture.session.data(from: origin)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    XCTAssertEqual(data, body)
  }
}
