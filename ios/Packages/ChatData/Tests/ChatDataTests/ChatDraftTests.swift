import ChatDataTestSupport
import ChatDomain
import Foundation
import Synchronization
import XCTest

@testable import ChatData

final class ChatDraftTests: XCTestCase {
  func testAtomicStorageReopensAndIsolatesOriginUserOrganizationAgentAndThread() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let origin = URL(string: "https://api.example.invalid")!
    let scope = ChatCacheScope(apiBaseURL: origin, userID: "user", workspaceID: "org")
    var document = ChatDraftDocument()
    document.replaceText("Restored after restart")
    let draft = ComposerDraft(document: document)
    let agent = ChatDraftTarget.agent("agent")
    let thread = ChatDraftTarget.thread(agentID: "agent", threadID: "thread")
    try ChatDraftStorage(scope: scope, directory: directory).save(draft, key: agent.key)
    let reopened = ChatDraftStorage(scope: scope, directory: directory)
    XCTAssertEqual(try reopened.load(agent.key, as: ComposerDraft.self), draft)
    XCTAssertNil(try reopened.load(thread.key, as: ComposerDraft.self))
    for other in [
      ChatCacheScope(apiBaseURL: origin, userID: "other", workspaceID: "org"),
      ChatCacheScope(apiBaseURL: origin, userID: "user", workspaceID: "other"),
      ChatCacheScope(
        apiBaseURL: URL(string: "https://other.example.invalid")!, userID: "user",
        workspaceID: "org"),
    ] {
      XCTAssertNil(
        try ChatDraftStorage(scope: other, directory: directory).load(
          agent.key, as: ComposerDraft.self))
    }
    try reopened.save(ComposerDraft(), key: agent.key)
    XCTAssertEqual(try reopened.load(agent.key, as: ComposerDraft.self), ComposerDraft())
  }

  func testIncompleteRemoteResponseFailsInsteadOfBecomingAnEmptyDraft() async throws {
    let fixture = ChatHTTPFixture { _ in ChatHTTPResponse(body: "{\"draftUserMessage\":null}") }
    do {
      _ = try await ChatDraftRepository(client: fixture.client).load(.agent("agent"))
      XCTFail("Missing required draft metadata must not silently clear local content")
    } catch APIClientError.incompatibleData {}
  }

  func testCanonicalThreadAndAgentDraftHTTPReadWriteAndExplicitNull() async throws {
    let writes = Mutex<[String: ComposerDraft]>([:])
    let paths = Mutex<[String]>([])
    let draft = try JSONDecoder().decode(
      ComposerDraft.self,
      from: Data(
        #"{"draftUserMessage":{"version":1,"parts":[{"type":"text","text":"Draft"},{"type":"chat_thread","threadId":"thread","titleSnapshot":"Referenced"}]},"draftAttachments":null}"#
          .utf8))
    let fixture = ChatHTTPFixture { request in
      let path = request.url!.path
      paths.withLock { $0.append(request.httpMethod! + " " + path) }
      if request.httpMethod == "PATCH" {
        let saved = try JSONDecoder().decode(ComposerDraft.self, from: chatRequestBody(request))
        writes.withLock { $0[path] = saved }
        return ChatHTTPResponse(status: 204, body: "")
      }
      return ChatHTTPResponse(
        body: String(decoding: try JSONEncoder().encode(draft), as: UTF8.self))
    }
    let repository = ChatDraftRepository(client: fixture.client)
    for target in [ChatDraftTarget.agent("agent"), .thread(agentID: "agent", threadID: "thread")] {
      let restored = try await repository.load(target)
      XCTAssertEqual(restored, draft)
      try await repository.save(restored, to: target)
      try await repository.save(ComposerDraft(), to: target)
    }
    XCTAssertEqual(
      paths.withLock { $0 },
      [
        "GET /api/agents/agent/draft", "PATCH /api/agents/agent/draft",
        "PATCH /api/agents/agent/draft", "GET /api/chat-threads/thread/draft",
        "PATCH /api/chat-threads/thread", "PATCH /api/chat-threads/thread",
      ])
    XCTAssertTrue(writes.withLock { $0.values.allSatisfy { $0 == ComposerDraft() } })
    let encoded =
      try JSONSerialization.jsonObject(with: JSONEncoder().encode(ComposerDraft()))
      as? [String: Any]
    XCTAssertTrue(encoded?["draftUserMessage"] is NSNull)
    XCTAssertTrue(encoded?["draftAttachments"] is NSNull)
  }
}
