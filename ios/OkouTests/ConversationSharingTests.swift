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
    let creationPath = "/api/chat-threads/\(threadID)/shared-threads/visibility"
    let questionID = "fa000000-0000-4000-8000-000000000001"
    let answerID = "fa000000-0000-4000-8000-000000000002"
    let fixture = ChatHTTPFixture { request in
      if request.httpMethod == "POST", request.url?.path == creationPath {
        let body = try XCTUnwrap(
          JSONSerialization.jsonObject(with: chatRequestBody(request)) as? [String: Any])
        let id = try XCTUnwrap(body["id"] as? String)
        let ids = try XCTUnwrap(body["eventIds"] as? [String])
        let failed = try state.withLock { value in
          if value.shareID == nil { value.shareID = id }
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
        XCTAssertEqual(body["expectedRevision"] as? String, "current-revision")
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
          body: "{\"id\":\"\(id)\",\"audience\":\"\(value.audience)\",\"revision\":\"current-revision\"}")
      }
    }
    let history = try ChatEventProjection.history(
      rows: [
        ChatEvent(
          id: questionID, runId: "run", createdAt: .now, eventType: .inputPrompt,
          payload: .init(userMessage: .init(parts: [.init(type: "text", text: "Private context")]))),
        ChatEvent(
          id: answerID, runId: "run", createdAt: .now, eventType: .outputMessage,
          payload: .init(content: "Answer")),
      ], recovering: false)
    let sharing = ConversationSharing(
      client: fixture.client, threadID: threadID, webURL: fixture.baseURL,
      lifecycleTasks: LifecycleTasks(), history: { history }, didFail: { _ in })
    defer { sharing.close() }
    sharing.start()
    for group in sharing.groups { sharing.toggle(group) }
    XCTAssertEqual(sharing.selectedCount, 2)
    XCTAssertEqual(sharing.selectedIDs, [questionID, answerID])
    sharing.toggle(try XCTUnwrap(sharing.groups.first))
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

  func testSelectedQuestionRemainsDeselectableWhenItsFirstPromptIsRevoked() throws {
    let fixture = ChatHTTPFixture { _ in throw URLError(.unsupportedURL) }
    let prompts = ["question", "context"].map { id in
      ChatEvent(
        id: id, runId: "run", createdAt: .now, eventType: .inputPrompt,
        payload: .init(userMessage: .init(parts: [.init(type: "text", text: id)])))
    }
    var history = try ChatEventProjection.history(rows: prompts, recovering: false)
    let sharing = ConversationSharing(
      client: fixture.client, threadID: "thread", webURL: fixture.baseURL,
      lifecycleTasks: LifecycleTasks(), history: { history }, didFail: { _ in })
    defer { sharing.close() }
    sharing.start()
    sharing.toggle(try XCTUnwrap(sharing.groups.first))
    history = try ChatEventProjection.history(
      rows: prompts + [
        ChatEvent(
          id: "revoke", revokesEventId: "question", createdAt: .now, eventType: .controlRevoke)
      ], recovering: false)
    XCTAssertEqual(sharing.selectedIDs, ["context"])
    XCTAssertEqual(sharing.selectedCount, 1)
    sharing.toggle(try XCTUnwrap(sharing.groups.first))
    XCTAssertTrue(sharing.selectedIDs.isEmpty)
    XCTAssertEqual(sharing.selectedCount, 0)
  }

  func testNewShareIsReadyWithoutAVisibilityReadAndCannotChangeItsSelection() async throws {
    let fixture = ChatHTTPFixture { request in
      guard request.httpMethod == "POST",
        request.url?.path == "/api/chat-threads/thread/shared-threads/visibility"
      else { throw URLError(.unsupportedURL) }
      let body = try XCTUnwrap(
        JSONSerialization.jsonObject(with: chatRequestBody(request)) as? [String: Any])
      XCTAssertEqual(body["eventIds"] as? [String], ["question"])
      XCTAssertEqual(body["audience"] as? String, "organization")
      let id = try XCTUnwrap(body["id"] as? String)
      return ChatHTTPResponse(status: 201, body: "{\"id\":\"\(id)\"}")
    }
    let history = try ChatEventProjection.history(
      rows: [
        ChatEvent(
          id: "question", runId: "run", createdAt: .now, eventType: .inputPrompt,
          payload: .init(userMessage: .init(parts: [.init(type: "text", text: "Question")]))),
      ], recovering: false)
    let sharing = ConversationSharing(
      client: fixture.client, threadID: "thread", webURL: fixture.baseURL,
      lifecycleTasks: LifecycleTasks(), history: { history }, didFail: { _ in })
    defer { sharing.close() }
    sharing.start()
    sharing.audience = .organization
    let group = try XCTUnwrap(sharing.groups.first)
    sharing.toggle(group)
    await sharing.create()?.value
    XCTAssertNotNil(sharing.link)
    XCTAssertEqual(sharing.visibility?.audience, .organization)
    XCTAssertNil(sharing.error)
    sharing.toggle(group)
    sharing.clear()
    XCTAssertEqual(sharing.selectedIDs, ["question"])
  }

  func testRetryRecoversACommittedShareWithoutCreatingAnotherLink() async throws {
    let shareID = Mutex<String?>(nil)
    let fixture = ChatHTTPFixture { request in
      if request.httpMethod == "POST",
        request.url?.path == "/api/chat-threads/thread/shared-threads/visibility"
      {
        let body = try XCTUnwrap(
          JSONSerialization.jsonObject(with: chatRequestBody(request)) as? [String: Any])
        let id = try XCTUnwrap(body["id"] as? String)
        try shareID.withLock { existing in
          guard existing == nil else { throw URLError(.unsupportedURL) }
          existing = id
        }
        throw URLError(.networkConnectionLost)
      }
      let id = try XCTUnwrap(shareID.withLock { $0 })
      guard request.httpMethod == "GET",
        request.url?.path == "/api/shared-threads/\(id)/visibility"
      else { throw URLError(.unsupportedURL) }
      return ChatHTTPResponse(
        body: "{\"id\":\"\(id)\",\"audience\":\"public\",\"revision\":\"confirmed\"}")
    }
    let history = try ChatEventProjection.history(
      rows: [
        ChatEvent(
          id: "question", runId: "run", createdAt: .now, eventType: .inputPrompt,
          payload: .init(userMessage: .init(parts: [.init(type: "text", text: "Question")]))),
      ], recovering: false)
    let sharing = ConversationSharing(
      client: fixture.client, threadID: "thread", webURL: fixture.baseURL,
      lifecycleTasks: LifecycleTasks(), history: { history }, didFail: { _ in })
    defer { sharing.close() }
    sharing.start()
    sharing.toggle(try XCTUnwrap(sharing.groups.first))
    await sharing.create()?.value
    XCTAssertNil(sharing.link)
    XCTAssertNotNil(sharing.error)
    await sharing.create()?.value
    XCTAssertEqual(sharing.link?.lastPathComponent, shareID.withLock { $0 })
    XCTAssertNil(sharing.error)
  }

  func testQuickShareUsesTheWebContractAndIncludesThePrecedingPromptGroup() async throws {
    let requests = Mutex<[URLRequest]>([])
    let fixture = ChatHTTPFixture { request in
      guard request.httpMethod == "POST",
        request.url?.path == "/api/chat-threads/thread/shared-threads/visibility"
      else { throw URLError(.unsupportedURL) }
      requests.withLock { $0.append(request) }
      return ChatHTTPResponse(status: 201, body: #"{"id":"share"}"#)
    }
    let history = try ChatEventProjection.history(
      rows: [
        ChatEvent(
          id: "question", runId: "run", createdAt: .now, eventType: .inputPrompt,
          payload: .init(userMessage: .init(parts: [.init(type: "text", text: "Question")]))),
        ChatEvent(
          id: "context", runId: "run", createdAt: .now, eventType: .inputPrompt,
          payload: .init(userMessage: .init(parts: [.init(type: "text", text: "Context")]))),
        ChatEvent(
          id: "work", runId: "run", createdAt: .now, eventType: .outputMessage,
          payload: .init(content: "Working")),
        ChatEvent(
          id: "answer", runId: "run", createdAt: .now, eventType: .outputMessage,
          payload: .init(content: "Answer")),
      ], recovering: false)
    let sharing = ConversationSharing(
      client: fixture.client, threadID: "thread", webURL: fixture.baseURL,
      lifecycleTasks: LifecycleTasks(), history: { history }, didFail: { _ in })
    defer { sharing.close() }
    _ = try await sharing.singleAnswerLink("answer", audience: .organization)
    let sent = requests.withLock { $0 }
    XCTAssertEqual(sent.count, 1)
    let request = try XCTUnwrap(sent.first)
    XCTAssertEqual(request.url?.path, "/api/chat-threads/thread/shared-threads/visibility")
    let body = try XCTUnwrap(
      JSONSerialization.jsonObject(with: chatRequestBody(request)) as? [String: Any])
    XCTAssertEqual(body["eventIds"] as? [String], ["question", "context", "answer"])
    XCTAssertEqual(body["audience"] as? String, "organization")
  }

}
