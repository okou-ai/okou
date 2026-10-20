import ChatData
import ChatDataTestSupport
import Foundation
import XCTest

@MainActor
final class ChatActivitySummaryTests: XCTestCase {
  private let thread = "10000000-0000-4000-8000-000000000001"
  private let run = "10000000-0000-4000-8000-000000000002"

  func testCanonicalAuthenticatedDemandPreservesLanguageAndStatus() async throws {
    for status in ["available", "ineligible", "unavailable"] {
      let fixture = ChatHTTPFixture { [thread, run] request in
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/chat-threads/\(thread)/activity-summary")
        XCTAssertEqual(
          request.value(forHTTPHeaderField: "Authorization"), "Bearer local-test-session")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Client-Type"), "iOS")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let body =
          try JSONSerialization.jsonObject(with: chatRequestBody(request)) as? [String: String]
        XCTAssertEqual(body, ["runId": run])
        return ChatHTTPResponse(
          body: """
            {"runId":"\(run)","messages":[{"id":"研究","text":"正在核对活动顺序"}],"status":"\(status)"}
            """)
      }
      let summary = try await fixture.client.activitySummary(threadID: thread, runID: run)
      XCTAssertEqual(summary.status.rawValue, status)
      XCTAssertEqual(summary.messages.map(\.text), ["正在核对活动顺序"])
    }
  }

  func testInvalidSummariesAndExistingHTTPErrorsKeepTheirContracts() async {
    let invalid = [
      "{\"runId\":\"\(thread)\",\"messages\":[],\"status\":\"available\"}",
      "{\"runId\":\"\(run)\",\"messages\":[{\"id\":\"x\",\"text\":\"\"}],\"status\":\"available\"}",
      "{\"runId\":\"\(run)\",\"messages\":[],\"status\":\"unknown\"}",
      "{\"runId\":\"\(run)\",\"messages\":["
        + Array(repeating: "{\"id\":\"x\",\"text\":\"text\"}", count: 5).joined(separator: ",")
        + "],\"status\":\"available\"}",
    ]
    for body in invalid {
      let fixture = ChatHTTPFixture { _ in ChatHTTPResponse(body: body) }
      do {
        _ = try await fixture.client.activitySummary(threadID: thread, runID: run)
        XCTFail("Invalid summary was accepted")
      } catch {
        XCTAssertEqual(
          (error as? APIClientError)?.localizedDescription,
          APIClientError.incompatibleData.localizedDescription)
      }
    }
    for status in [401, 403, 404, 426, 500] {
      let fixture = ChatHTTPFixture { _ in
        ChatHTTPResponse(
          status: status, body: "{\"error\":{\"code\":\"TEST_ERROR\",\"message\":\"Unavailable\"}}")
      }
      do {
        _ = try await fixture.client.activitySummary(threadID: thread, runID: run)
        XCTFail("HTTP error was accepted")
      } catch {
        XCTAssertEqual((error as? APIClientError)?.statusCode, status)
        XCTAssertEqual((error as? APIClientError)?.serverCode, "TEST_ERROR")
      }
    }
  }
}
