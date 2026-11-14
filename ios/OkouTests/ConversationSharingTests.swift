import ChatData
import ChatDataTestSupport
import ChatDomain
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class ConversationSharingTests: XCTestCase {
  func testFailedCreationKeepsExactSelectionAndRetryIdentityThenCanRestrictTheLink() async throws {
    struct State: Sendable {
      var shareID: String?
      var attempts: [[String: String]] = []
      var failNext = true
      var created = false
      var audience = "public"
    }
    let state = Mutex(State())
    let threadID = UUID().uuidString
    let selectionPath = "/api/chat-threads/\(threadID)/shared-threads/selection"
    let questionID = "fa000000-0000-4000-8000-000000000001"
    let answerID = "fa000000-0000-4000-8000-000000000002"
    let fixture = ChatHTTPFixture { request in
      if request.url?.path == selectionPath {
        switch request.httpMethod {
        case "POST":
          let body = try XCTUnwrap(
            JSONSerialization.jsonObject(with: chatRequestBody(request)) as? [String: Any])
          let id = try XCTUnwrap(body["id"] as? String)
          let ids = try XCTUnwrap(body["eventIds"] as? [String])
          let failed = try state.withLock { value in
            guard value.shareID == id else { throw URLError(.unsupportedURL) }
            value.attempts.append(["id": id, "events": ids.joined(separator: ",")])
            if value.failNext {
              value.failNext = false
              return true
            }
            value.created = true
            return false
          }
          if failed {
            return ChatHTTPResponse(status: 503, body: #"{"error":{"message":"Try again"}}"#)
          }
          return ChatHTTPResponse(status: 201, body: "{\"id\":\"\(id)\"}")
        case "GET":
          return ChatHTTPResponse(
            body: """
              {"messages":[
                {"eventId":"\(questionID)","role":"user","turnEventIds":["\(questionID)"]},
                {"eventId":"\(answerID)","role":"assistant","turnEventIds":["\(questionID)","\(answerID)"]}
              ]}
              """)
        default:
          throw URLError(.unsupportedURL)
        }
      }

      guard let url = request.url else { throw URLError(.unsupportedURL) }
      let id = url.deletingLastPathComponent().lastPathComponent
      guard UUID(uuidString: id) != nil, url.path == "/api/shared-threads/\(id)/visibility" else {
        throw URLError(.unsupportedURL)
      }
      let audience: String?
      switch request.httpMethod {
      case "GET":
        audience = nil
      case "PUT":
        let body = try XCTUnwrap(
          JSONSerialization.jsonObject(with: chatRequestBody(request)) as? [String: Any])
        audience = try XCTUnwrap(body["audience"] as? String)
      default:
        throw URLError(.unsupportedURL)
      }
      return try state.withLock { value in
        if value.shareID == nil, request.httpMethod == "GET" { value.shareID = id }
        guard value.shareID == id else { throw URLError(.unsupportedURL) }
        if let audience {
          guard value.created else { throw URLError(.unsupportedURL) }
          value.audience = audience
        }
        guard value.created else {
          return ChatHTTPResponse(status: 404, body: #"{"error":{"message":"Not found"}}"#)
        }
        return ChatHTTPResponse(
          body: "{\"id\":\"\(id)\",\"audience\":\"\(value.audience)\",\"revision\":null}")
      }
    }
    let sharing = ConversationSharing(
      client: fixture.client, threadID: threadID, webURL: fixture.baseURL,
      lifecycleTasks: LifecycleTasks(), didFail: { _ in })
    defer { sharing.close() }
    await sharing.start(answerID: answerID)?.value
    XCTAssertEqual(sharing.selectedIDs, [questionID, answerID])
    let question = ChatMessage(
      id: questionID, role: .user, text: "Private context", createdAt: .now,
      runID: nil, isQueued: false, isError: false)
    sharing.toggle(question, messages: [question])
    await sharing.create()?.value
    XCTAssertEqual(sharing.selectedIDs, [answerID])
    await sharing.create()?.value
    let writes = state.withLock { $0.attempts }
    XCTAssertEqual(writes.count, 2)
    XCTAssertEqual(writes.first, writes.last)
    XCTAssertEqual(writes.last?["events"], answerID)
    XCTAssertEqual(sharing.link?.lastPathComponent, writes.last?["id"])
    await sharing.changeAudience(.private)?.value
    XCTAssertEqual(sharing.visibility?.audience, .private)
  }
}
