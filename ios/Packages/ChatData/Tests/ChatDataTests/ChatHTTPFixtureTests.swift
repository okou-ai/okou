import ChatData
import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@MainActor
final class ChatHTTPFixtureTests: XCTestCase {
  func testReturnedClientKeepsItsExternalFixtureAliveForRequests() async throws {
    func makeClient() -> APIClient {
      ChatHTTPFixture { request in
        XCTAssertEqual(request.url?.path, "/api/fixture-lifetime")
        return ChatHTTPResponse(body: #"{"value":"Owned by the returned client"}"#)
      }.client
    }
    let client = makeClient()
    let result: [String: String] = try await client.request("/api/fixture-lifetime")
    XCTAssertEqual(result, ["value": "Owned by the returned client"])
  }

  func testUnknownOriginIsRejectedByTheFixtureWithoutDNSFallback() async throws {
    let reports = Mutex<[String]>([])
    let fixture = ChatHTTPFixture(
      onUnhandledRequest: { message in
        reports.withLock { $0.append(message) }
      },
      handler: { _ in
        XCTFail("An unknown origin must not reach a different fixture's handler")
        return ChatHTTPResponse(body: "{}")
      })
    for scheme in ["https", "http"] {
      let url = try XCTUnwrap(
        URL(string: "\(scheme)://unregistered-\(UUID().uuidString).example.invalid"))
      do {
        _ = try await fixture.session.data(from: url)
        XCTFail("An unregistered HTTP origin must be rejected")
      } catch let error as URLError {
        XCTAssertEqual(error.code, .unsupportedURL)
        XCTAssertTrue(error.localizedDescription.contains(url.absoluteString))
        XCTAssertTrue(reports.withLock { $0.contains { $0.contains(url.absoluteString) } })
      }
    }
  }

  func testClosingFixtureCancelsItsRequestWithoutContaminatingAnotherFixture() async throws {
    let reports = Mutex<[String]>([])
    let started = expectation(description: "Retiring fixture request started")
    let (responses, continuation) = AsyncStream<Void>.makeStream()
    defer { continuation.finish() }
    var retiring: ChatHTTPFixture? = ChatHTTPFixture(
      onUnhandledRequest: { message in reports.withLock { $0.append(message) } },
      handler: { _ in
        started.fulfill()
        for await _ in responses { break }
        return ChatHTTPResponse(body: "{}")
      })
    let session = try XCTUnwrap(retiring).session
    let url = try XCTUnwrap(retiring).baseURL.appending(path: "api/retiring")
    let request = Task { try await session.data(from: url) }
    defer { request.cancel() }
    await fulfillment(of: [started], timeout: 3)

    let active = ChatHTTPFixture(
      onUnhandledRequest: { message in reports.withLock { $0.append(message) } },
      handler: { _ in ChatHTTPResponse(body: "Active fixture") })
    retiring = nil
    do {
      _ = try await request.value
      XCTFail("Closing the fixture must cancel its outstanding request")
    } catch let error as URLError {
      XCTAssertEqual(error.code, .cancelled)
    }
    let (data, _) = try await active.session.data(from: active.baseURL)
    XCTAssertEqual(data, Data("Active fixture".utf8))
    XCTAssertTrue(reports.withLock { $0.isEmpty })
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

  func testRetiringStartedRequestsCannotReportToAnotherLiveFixture() async throws {
    let reports = Mutex<[String]>([])
    let active = ChatHTTPFixture(
      onUnhandledRequest: { message in reports.withLock { $0.append(message) } },
      handler: { _ in ChatHTTPResponse(body: "Active fixture") })
    try await withThrowingTaskGroup(of: Void.self) { group in
      for _ in 0..<40 {
        group.addTask {
          var retiring: ChatHTTPFixture? = ChatHTTPFixture(
            onUnhandledRequest: { message in reports.withLock { $0.append(message) } },
            handler: { _ in ChatHTTPResponse(body: "Retiring fixture") })
          let session = try XCTUnwrap(retiring).session
          let url = try XCTUnwrap(retiring).baseURL.appending(path: "api/retiring-started")
          do {
            let data: Data = try await withCheckedThrowingContinuation { continuation in
              let request = session.dataTask(with: url) { data, _, error in
                if let error {
                  continuation.resume(throwing: error)
                } else if let data {
                  continuation.resume(returning: data)
                } else {
                  continuation.resume(throwing: URLError(.badServerResponse))
                }
              }
              request.resume()
              // Construct and start the SDK task while its fixture is still live.
              retiring = nil
            }
            XCTAssertEqual(data, Data("Retiring fixture".utf8))
          } catch let error as URLError {
            XCTAssertEqual(error.code, .cancelled, error.localizedDescription)
          }
        }
      }
      try await group.waitForAll()
    }
    let (data, _) = try await active.session.data(from: active.baseURL)
    XCTAssertEqual(data, Data("Active fixture".utf8))
    XCTAssertEqual(reports.withLock { $0 }, [])
  }
}
