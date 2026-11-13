import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import ChatData

@MainActor
final class ChatSharingTests: XCTestCase {
  func testSharingUsesTheExistingWebVisibilityContract() async throws {
    let requests = Mutex<[URLRequest]>([])
    let fixture = ChatHTTPFixture { request in
      requests.withLock { $0.append(request) }
      if request.httpMethod == "POST" {
        return ChatHTTPResponse(status: 201, body: #"{"id":"share"}"#)
      }
      return ChatHTTPResponse(body: #"{"id":"share","audience":"organization","revision":null}"#)
    }
    let id = try await fixture.client.shareThread(
      threadID: "thread", eventIDs: ["answer"], audience: .organization, id: "share")
    let visibility = try await fixture.client.changeChatShareVisibility(
      id: id, audience: .organization, revision: nil)
    XCTAssertEqual(visibility.audience, .organization)
    let writes = requests.withLock { $0.filter { $0.httpMethod != "GET" } }
    let creation = try XCTUnwrap(writes.first)
    XCTAssertEqual(creation.url?.path, "/api/chat-threads/thread/shared-threads/visibility")
    let creationBody = try XCTUnwrap(
      JSONSerialization.jsonObject(with: chatRequestBody(creation)) as? [String: Any])
    XCTAssertEqual(creationBody["eventIds"] as? [String], ["answer"])
    XCTAssertEqual(creationBody["id"] as? String, "share")
    let update = try XCTUnwrap(writes.last)
    let updateBody = try XCTUnwrap(
      JSONSerialization.jsonObject(with: chatRequestBody(update)) as? [String: Any])
    XCTAssertTrue(updateBody["expectedRevision"] is NSNull)
  }
}
