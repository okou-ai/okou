import ChatData
import ChatDataTestSupport
import ChatDomain
import QuickLook
import SwiftUI
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class MessageAttachmentTests: XCTestCase {

  func testHistoryAndSQLiteReopenKeepFileOnlyAndMixedAttachments() async throws {
    let fixture = ConversationHistoryFixture(rows: [
      try attachmentRow(1, text: ""), try attachmentRow(2, text: "Review these files"),
    ])
    let cacheDirectory = CacheTestDirectory(owner: self)
    let scope = ChatCacheScope(
      apiBaseURL: fixture.http.baseURL, userID: "reader", workspaceID: "workspace")
    let conversation = fixture.conversation(cache: cacheDirectory.cache(scope: scope))
    await conversation.refresh()
    XCTAssertNil(conversation.error)
    XCTAssertEqual(conversation.messages.map(\.text), ["", "Review these files"])
    XCTAssertEqual(
      conversation.messages.first?.attachments.map(\.id), ["image", "movie", "pdf", "other"])
    let expected = conversation.messages
    conversation.close()
    let sync = ChatSync(
      client: fixture.http.client, cache: cacheDirectory.cache(scope: scope))
    let reopened = await sync.cachedHistory(threadID: ConversationHistoryFixture.threadID)
    XCTAssertEqual(reopened?.messages, expected)
  }

  func testPreviewFailureRetryDismissAndWorkspaceCloseReleaseFiles() async throws {
    let denied = Mutex(true)
    let server = try ChatFileHTTPServer { _ in .init(body: Data("local-file".utf8)) }
    let origin = try await server.start()
    defer { server.stop() }
    let fixture = ChatHTTPFixture { _ in
      if denied.withLock({ $0 }) {
        return ChatHTTPResponse(status: 403, body: "{\"error\":{\"message\":\"Forbidden\"}}")
      }
      return ChatHTTPResponse(
        body: "{\"url\":\"\(origin)/file\",\"downloadUrl\":\"\(origin)/file\"}")
    }
    let viewer = MessageAttachmentStore(
      commands: ChatCommands(client: fixture.client, sync: ChatSync(client: fixture.client)),
      didFail: { _ in })
    defer { viewer.close() }
    let file = ChatMessageAttachment(id: "file", filename: "notes.txt", contentType: "text/plain")
    viewer.open(file)
    try await eventually { viewer.preview?.error != nil }
    XCTAssertTrue(
      viewer.preview?.error?.contains("permission") == true,
      viewer.preview?.error ?? "Missing error")
    denied.withLock { $0 = false }
    viewer.open(file)
    try await eventually { viewer.preview?.file != nil }
    let url = try XCTUnwrap(viewer.preview?.file?.url)
    XCTAssertEqual(try Data(contentsOf: url), Data("local-file".utf8))
    viewer.dismiss()
    XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    viewer.open(file)
    try await eventually { viewer.preview?.file != nil }
    let second = try XCTUnwrap(viewer.preview?.file?.url)
    viewer.close()
    XCTAssertNil(viewer.preview)
    XCTAssertFalse(FileManager.default.fileExists(atPath: second.path))
    viewer.open(file)
    XCTAssertNil(viewer.preview)
  }

  func testLeavingDetailCancelsPendingDownloadAndReentryCannotPublishItsOldResult() async throws {
    let entered = expectation(description: "Attachment authorization started")
    let (stream, continuation) = AsyncStream<Void>.makeStream()
    defer { continuation.finish() }
    let first = Mutex(true)
    let server = try ChatFileHTTPServer { _ in .init(body: Data("new-scope-file".utf8)) }
    let origin = try await server.start()
    defer { server.stop() }
    let fixture = ChatHTTPFixture { _ in
      let waits = first.withLock { value in
        let previous = value
        value = false
        return previous
      }
      if waits {
        entered.fulfill()
        for await _ in stream { break }
      }
      return ChatHTTPResponse(
        body: "{\"url\":\"\(origin)/file\",\"downloadUrl\":\"\(origin)/file\"}")
    }
    let viewer = MessageAttachmentStore(
      commands: ChatCommands(client: fixture.client, sync: ChatSync(client: fixture.client)),
      didFail: { _ in })
    defer { viewer.close() }
    viewer.open(.init(id: "old", filename: "old.txt", contentType: "text/plain"))
    await fulfillment(of: [entered], timeout: 3)
    viewer.deactivate()
    XCTAssertNil(viewer.preview)
    continuation.yield(())
    viewer.open(.init(id: "new", filename: "new.txt", contentType: "text/plain"))
    try await eventually { viewer.preview?.file != nil }
    XCTAssertEqual(viewer.preview?.attachment.id, "new")
    XCTAssertEqual(viewer.preview?.file?.url.lastPathComponent, "new.txt")
  }

  func testPreviousDetailCannotCancelReplacementAttachmentPreview() async throws {
    let server = try ChatFileHTTPServer { _ in .init(body: Data("current detail".utf8)) }
    let origin = try await server.start()
    defer { server.stop() }
    let fixture = ConversationHistoryFixture(rows: [], fileOrigin: origin)
    let conversation = fixture.conversation()
    defer { conversation.close() }
    let previousOwner = UUID()
    let currentOwner = UUID()
    conversation.setDetailVisible(true, owner: previousOwner)
    conversation.setDetailVisible(true, owner: currentOwner)
    conversation.attachmentViewer.open(
      .init(id: "file", filename: "notes.txt", contentType: "text/plain"))
    try await eventually { conversation.attachmentViewer.preview?.file != nil }
    let url = try XCTUnwrap(conversation.attachmentViewer.preview?.file?.url)
    conversation.setDetailVisible(false, owner: previousOwner)
    XCTAssertEqual(conversation.attachmentViewer.preview?.attachment.id, "file")
    XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
    conversation.setDetailVisible(false, owner: currentOwner)
    XCTAssertNil(conversation.attachmentViewer.preview)
    XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
  }

}

private func attachmentRow(_ sequence: Int, text: String) throws -> String {
  let files: [[String: String]] = [
    [
      "type": "file", "fileId": "image", "filenameSnapshot": "Coast.png",
      "contentType": "image/png",
    ],
    [
      "type": "file", "fileId": "movie", "filenameSnapshot": "Walkthrough.mov",
      "contentType": "video/quicktime",
    ],
    [
      "type": "file", "fileId": "pdf", "filenameSnapshot": "Project brief.pdf",
      "contentType": "application/pdf",
    ],
    [
      "type": "file", "fileId": "other", "filenameSnapshot": "Archive.custom",
      "contentType": "application/octet-stream",
    ],
  ]
  let parts = text.isEmpty ? files : [["type": "text", "text": text]] + files
  let row: [String: Any] = [
    "id": ConversationHistoryFixture.id(sequence), "seqId": sequence,
    "chatThreadId": ConversationHistoryFixture.threadID,
    "createdAt": "2026-10-20T00:00:00Z", "eventType": "input.prompt", "runId": NSNull(),
    "revokesEventId": NSNull(), "payload": ["userMessage": ["version": 1, "parts": parts]],
  ]
  return String(decoding: try JSONSerialization.data(withJSONObject: row), as: UTF8.self)
}

@MainActor
private func previewController(in controller: UIViewController) -> QLPreviewController? {
  if let preview = controller as? QLPreviewController { return preview }
  if let presented = controller.presentedViewController,
    let preview = previewController(in: presented)
  {
    return preview
  }
  return controller.children.lazy.compactMap { previewController(in: $0) }.first
}
