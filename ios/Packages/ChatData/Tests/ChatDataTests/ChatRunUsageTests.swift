import ChatDataTestSupport
import Foundation
import XCTest

@testable import ChatData

final class ChatRunUsageTests: XCTestCase {
  func testReadsBoundedDeduplicatedRunsThroughAuthenticatedThreadEndpoint() async throws {
    let fixture = ChatHTTPFixture { request in
      XCTAssertEqual(request.url?.path, "/api/chat-threads/thread/usage")
      XCTAssertEqual(request.httpMethod, "POST")
      XCTAssertEqual(
        request.value(forHTTPHeaderField: "Authorization"), "Bearer local-test-session")
      XCTAssertEqual(request.value(forHTTPHeaderField: "X-Client-Type"), "iOS")
      let body = try JSONDecoder().decode(Body.self, from: chatRequestBody(request))
      XCTAssertEqual(body.runIds, ["run-a", "run-b"])
      return ChatHTTPResponse(
        body: """
          {"runs":[{"runId":"run-a","usage":{"version":1,"totalCredits":1234,"settledAt":"2026-10-20T00:00:00Z","breakdown":[{"kind":"model","credits":1234,"providers":[{"provider":"anthropic/claude-opus-4.8","credits":1234}]}]}},{"runId":"run-b","usage":{"version":1,"totalCredits":0,"settledAt":"2026-10-20T00:00:00Z","breakdown":[]}}]}
          """)
    }
    let usage = try await ChatSync(client: fixture.client).runUsage(
      threadID: "thread", runIDs: ["run-b", "run-a", "run-b"])
    XCTAssertEqual(usage["run-a"]?.totalCredits, 1234)
    XCTAssertEqual(
      usage["run-a"]?.breakdown.first?.providers.first?.provider, "anthropic/claude-opus-4.8")
    XCTAssertEqual(usage["run-b"]?.totalCredits, 0)
    XCTAssertNil(usage["missing"])
  }

  func testOmittedRunsAreMissingAndHTTPFailureIsNotZero() async throws {
    let empty = ChatHTTPFixture { _ in ChatHTTPResponse(body: "{\"runs\":[]}") }
    let result = try await ChatSync(client: empty.client).runUsage(
      threadID: "thread", runIDs: ["run"])
    XCTAssertTrue(result.isEmpty)
    for status in [403, 404, 503] {
      let fixture = ChatHTTPFixture { _ in
        ChatHTTPResponse(status: status, body: "{\"error\":{\"message\":\"Unavailable\"}}")
      }
      do {
        _ = try await ChatSync(client: fixture.client).runUsage(threadID: "thread", runIDs: ["run"])
        XCTFail("A failed usage read must not become a zero receipt")
      } catch let error as APIClientError { XCTAssertEqual(error.statusCode, status) }
    }
  }

  func testRejectsMalformedOrUnrequestedReceipts() async throws {
    for body in [
      "{\"runs\":[{\"runId\":\"other\",\"usage\":\(receipt)}]}",
      "{\"runs\":[{\"runId\":\"run\",\"usage\":\(receipt.replacingOccurrences(of: "\"version\":1", with: "\"version\":2"))}]}",
      "{\"runs\":[{\"runId\":\"run\",\"usage\":\(receipt.replacingOccurrences(of: "\"totalCredits\":0", with: "\"totalCredits\":-1"))}]}",
      "{\"runs\":[{\"runId\":\"run\",\"usage\":\(receipt)},{\"runId\":\"run\",\"usage\":\(receipt)}]}",
    ] {
      let fixture = ChatHTTPFixture { _ in ChatHTTPResponse(body: body) }
      do {
        _ = try await ChatSync(client: fixture.client).runUsage(threadID: "thread", runIDs: ["run"])
        XCTFail("Malformed receipts must not be displayed")
      } catch let error as APIClientError {
        if case .incompatibleData = error {} else { XCTFail("Unexpected error: \(error)") }
      }
    }
  }

  private struct Body: Decodable { let runIds: [String] }
  private let receipt =
    "{\"version\":1,\"totalCredits\":0,\"settledAt\":\"2026-10-20T00:00:00Z\",\"breakdown\":[]}"
}
