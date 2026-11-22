import ChatDataTestSupport
import ChatDomain
import CryptoKit
import Foundation
import Synchronization
import XCTest

@testable import ChatData

final class ChatDraftTests: XCTestCase {
  func testUpgradeRecoversVoiceAlongsideANewerWorkspaceDraftAndCanRetry() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let scope = ChatCacheScope(
      apiBaseURL: URL(string: "https://api.example.invalid")!, userID: "member", workspaceID: "org")
    let storage = ChatDraftStorage(scope: scope, directory: root)
    try storage.save("current draft", key: "workspace")
    let previousKey = "agent/previous"
    try storage.save("previous draft", key: previousKey)
    let currentVoice = storage.voiceDraft(for: .workspace).directory
    let oldVoiceName = SHA256.hash(data: Data((previousKey + "/voice").utf8))
      .map { String(format: "%02x", $0) }.joined()
    let oldVoice = currentVoice.deletingLastPathComponent().appendingPathComponent(oldVoiceName)
    try FileManager.default.createDirectory(at: oldVoice, withIntermediateDirectories: true)
    let bytes = Data([0x01, 0x02])
    try bytes.write(to: oldVoice.appendingPathComponent("samples.pcm"))

    for _ in 0..<2 {
      let restored = storage.recoveringWorkspace(from: "previous")
      XCTAssertTrue(restored.migrated)
      XCTAssertEqual(try restored.storage.load("workspace", as: String.self), "current draft")
      XCTAssertEqual(
        try Data(contentsOf: currentVoice.appendingPathComponent("samples.pcm")), bytes)
    }
    XCTAssertFalse(FileManager.default.fileExists(atPath: oldVoice.path))
  }

  func testAtomicStorageReopensAndIsolatesOriginUserOrganizationAndThread() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let origin = URL(string: "https://api.example.invalid")!
    let scope = ChatCacheScope(apiBaseURL: origin, userID: "user", workspaceID: "org")
    var document = ChatDraftDocument()
    document.replaceText("Restored after restart")
    let message = ChatMessage(
      id: "assistant-event", role: .assistant, text: "🌷 Selected passage", createdAt: Date(),
      isQueued: false, isError: false)
    let selection = try XCTUnwrap(
      ChatFeedbackSelection(
        message: message, range: (message.text as NSString).range(of: "Selected passage")))
    document.parts.append(selection.part)
    let draft = ComposerDraft(document: document)
    let workspace = ChatDraftTarget.workspace
    let thread = ChatDraftTarget.thread("thread")
    try ChatDraftStorage(scope: scope, directory: directory).save(draft, key: workspace.key)
    let reopened = ChatDraftStorage(scope: scope, directory: directory)
    XCTAssertEqual(try reopened.load(workspace.key, as: ComposerDraft.self), draft)
    XCTAssertNil(try reopened.load(thread.key, as: ComposerDraft.self))
    for other in [
      ChatCacheScope(apiBaseURL: origin, userID: "other", workspaceID: "org"),
      ChatCacheScope(apiBaseURL: origin, userID: "user", workspaceID: "other"),
      ChatCacheScope(
        apiBaseURL: URL(string: "https://other.example.invalid")!, userID: "user",
        workspaceID: "org")
    ] {
      XCTAssertNil(
        try ChatDraftStorage(scope: other, directory: directory).load(
          workspace.key, as: ComposerDraft.self))
    }
    try reopened.save(ComposerDraft(), key: workspace.key)
    XCTAssertEqual(try reopened.load(workspace.key, as: ComposerDraft.self), ComposerDraft())
  }

  func testIncompleteRemoteResponseFailsInsteadOfBecomingAnEmptyDraft() async throws {
    let fixture = ChatHTTPFixture { _ in ChatHTTPResponse(body: "{\"draftUserMessage\":null}") }
    do {
      _ = try await ChatDraftRepository(client: fixture.client).load(.workspace)
      XCTFail("Missing required draft metadata must not silently clear local content")
    } catch APIClientError.incompatibleData {}
  }

  func testMemberAndThreadDraftsUseTheirOwnRoutes() async throws {
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
      return try ChatHTTPResponse(
        json: draft)
    }
    let repository = ChatDraftRepository(client: fixture.client)
    for target in [ChatDraftTarget.workspace, .thread("thread")] {
      let restored = try await repository.load(target)
      XCTAssertEqual(restored, draft)
      try await repository.save(restored, to: target)
      try await repository.save(ComposerDraft(), to: target)
    }
    XCTAssertEqual(
      paths.withLock { $0 },
      [
        "GET /api/chat-drafts/composer", "PATCH /api/chat-drafts/composer",
        "PATCH /api/chat-drafts/composer", "GET /api/chat-threads/thread/draft",
        "PATCH /api/chat-threads/thread", "PATCH /api/chat-threads/thread"
      ])
    XCTAssertTrue(writes.withLock { $0.values.allSatisfy { $0 == ComposerDraft() } })
    let encoded =
      try JSONSerialization.jsonObject(with: JSONEncoder().encode(ComposerDraft()))
      as? [String: Any]
    XCTAssertTrue(encoded?["draftUserMessage"] is NSNull)
    XCTAssertTrue(encoded?["draftAttachments"] is NSNull)
  }
}
