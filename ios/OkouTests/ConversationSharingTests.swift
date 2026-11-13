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
      var attempts: [[String: String]] = []
      var failNext = true
      var created = false
      var audience = "public"
    }
    let state = Mutex(State())
    let questionID = "fa000000-0000-4000-8000-000000000001"
    let answerID = "fa000000-0000-4000-8000-000000000002"
    let fixture = ChatHTTPFixture { request in
      if request.url?.path.hasSuffix("/selection") == true {
        if request.httpMethod == "POST" {
          let body = try XCTUnwrap(
            JSONSerialization.jsonObject(with: chatRequestBody(request)) as? [String: Any])
          let id = try XCTUnwrap(body["id"] as? String)
          let ids = try XCTUnwrap(body["eventIds"] as? [String])
          let failed = state.withLock { value in
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
        }
        return ChatHTTPResponse(
          body: """
            {"messages":[
              {"eventId":"\(questionID)","role":"user","turnEventIds":["\(questionID)"]},
              {"eventId":"\(answerID)","role":"assistant","turnEventIds":["\(questionID)","\(answerID)"]}
            ]}
            """)
      }
      if request.httpMethod == "PUT" {
        let body = try XCTUnwrap(
          JSONSerialization.jsonObject(with: chatRequestBody(request)) as? [String: Any])
        let audience = try XCTUnwrap(body["audience"] as? String)
        state.withLock { $0.audience = audience }
      }
      return state.withLock { value in
        guard value.created, let id = value.attempts.last?["id"] else {
          return ChatHTTPResponse(status: 404, body: #"{"error":{"message":"Not found"}}"#)
        }
        return ChatHTTPResponse(
          body: "{\"id\":\"\(id)\",\"audience\":\"\(value.audience)\",\"revision\":null}")
      }
    }
    let sharing = ConversationSharing(
      client: fixture.client, threadID: UUID().uuidString, webURL: fixture.baseURL,
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
