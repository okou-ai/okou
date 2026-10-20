import ChatData
import ChatDataTestSupport
import Foundation
import XCTest

final class ChatSearchTests: XCTestCase, @unchecked Sendable {
  func testWorkspaceSearchUsesCanonicalQueryAndUTF16SnippetAroundHit() async throws {
    let content =
      String(repeating: "before ", count: 30) + "🪷needle" + String(repeating: " after", count: 30)
    let start = (content as NSString).range(of: "needle").location
    let encoded = String(decoding: try JSONEncoder().encode(content), as: UTF8.self)
    let fixture = ChatHTTPFixture { request in
      XCTAssertEqual(request.url?.path, "/api/chat/search")
      XCTAssertEqual(request.httpMethod, "GET")
      let items = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems
      XCTAssertEqual(items, [URLQueryItem(name: "keyword", value: "needle")])
      return ChatHTTPResponse(
        body: """
          {"results":[{"chatThreadId":"thread","agentName":"Research","matchedMessage":{"chatThreadId":"thread","role":"assistant","content":\(encoded),"createdAt":"2026-10-19T12:00:00Z","seqId":21,"runId":null},"matchedRanges":[{"start":\(start),"end":\(start + 6)}]}]}
          """)
    }
    let results = try await ChatSync(client: fixture.client).searchMessages(keyword: "needle")
    let result = try XCTUnwrap(results.first)
    XCTAssertEqual(result.id, "thread:21")
    let snippet = String(result.snippet.characters)
    XCTAssertTrue(snippet.contains("🪷needle"))
    XCTAssertLessThan(snippet.count, content.count)
    XCTAssertFalse(snippet.contains("�"))
    XCTAssertTrue(
      result.snippet.runs.contains { $0.inlinePresentationIntent == .stronglyEmphasized })
  }

  func testSearchAuthorizationFailureIsNotAnEmptyResult() async throws {
    let fixture = ChatHTTPFixture { _ in
      ChatHTTPResponse(status: 403, body: "{\"error\":{\"message\":\"Forbidden\"}}")
    }
    do {
      _ = try await ChatSync(client: fixture.client).searchMessages(keyword: "private")
      XCTFail("A denied search must remain an error")
    } catch let error as APIClientError {
      XCTAssertEqual(error.statusCode, 403)
    }
  }
}
