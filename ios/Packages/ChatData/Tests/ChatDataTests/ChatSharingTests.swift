import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import ChatData

@MainActor
final class ChatSharingTests: XCTestCase {
  func testSelectionCreationAndVisibilityUseCanonicalEventIdentities() async throws {
    let requests = Mutex<[URLRequest]>([])
    let fixture = ChatHTTPFixture { request in
      requests.withLock { $0.append(request) }
      if request.url?.path.hasSuffix("/selection") == true {
        if request.httpMethod == "POST" {
          return ChatHTTPResponse(status: 201, body: #"{"id":"share"}"#)
        }
        return ChatHTTPResponse(
          body:
            #"{"messages":[{"eventId":"answer","role":"assistant","turnEventIds":["question","answer"]}]}"#
        )
      }
      return ChatHTTPResponse(body: #"{"id":"share","audience":"organization","revision":null}"#)
    }
    let selection = try await fixture.client.chatShareSelection(threadID: "thread")
    let answer = try XCTUnwrap(selection.messages.first)
    XCTAssertEqual(answer.turnEventIds, ["question", "answer"])
    let id = try await fixture.client.createSelectedChatShare(
      threadID: "thread", eventIDs: [answer.eventId], audience: .organization, id: "share")
    let visibility = try await fixture.client.changeChatShareVisibility(
      id: id, audience: .organization, revision: nil)
    XCTAssertEqual(visibility.audience, .organization)
    let writes = requests.withLock { $0.filter { $0.httpMethod != "GET" } }
    let creation = try XCTUnwrap(writes.first)
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
