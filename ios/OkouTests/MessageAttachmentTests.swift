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

  func testPreviewRetryKeepsFileForReopeningUntilWorkspaceCloses() async throws {
    let denied = Mutex(true)
    let server = try ChatFileHTTPServer { _ in
      .init(headers: ["Cache-Control": "no-store"], body: Data("local-file".utf8))
    }
    addTeardownBlock { await server.stop() }
    let origin = try await server.start()
    let fixture = ChatHTTPFixture { request in
      guard request.httpMethod == "GET", request.url?.path == "/api/web/file-url" else {
        throw URLError(.unsupportedURL)
      }
      if denied.withLock({ $0 }) {
        return ChatHTTPResponse(status: 403, body: "{\"error\":{\"message\":\"Forbidden\"}}")
      }
      return ChatHTTPResponse(
        body: "{\"url\":\"\(origin)/file\",\"downloadUrl\":\"\(origin)/file\"}")
    }
    let commands = ChatCommands(client: fixture.client, sync: ChatSync(client: fixture.client))
    defer { commands.closeFileCache() }
    let viewer = MessageAttachmentStore(commands: commands, didFail: { _ in })
    defer { viewer.close() }
    let file = ChatMessageAttachment(id: "file", filename: "notes.txt", contentType: "text/plain")
    viewer.open(file)
    let deniedPreview = try XCTUnwrap(viewer.preview)
    do {
      _ = try await deniedPreview.store.get(deniedPreview.file).value
      XCTFail("A denied preview must expose its authorization failure")
    } catch {
      XCTAssertEqual((error as? APIClientError)?.statusCode, 403)
      XCTAssertTrue(MessageAttachmentStore.message(for: error).contains("permission"))
      XCTAssertFalse(ChatRequestFailure.canRetry(error))
    }
    denied.withLock { $0 = false }
    viewer.open(file)
    let url = try await previewURL(in: viewer)
    XCTAssertEqual(try Data(contentsOf: url), Data("local-file".utf8))
    viewer.dismiss()
    XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
    viewer.open(file)
    let second = try await previewURL(in: viewer)
    viewer.close()
    XCTAssertNil(viewer.preview)
    XCTAssertTrue(FileManager.default.fileExists(atPath: second.path))
    commands.closeFileCache()
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
    addTeardownBlock { await server.stop() }
    let origin = try await server.start()
    let fixture = ChatHTTPFixture { request in
      guard request.httpMethod == "GET", request.url?.path == "/api/web/file-url" else {
        throw URLError(.unsupportedURL)
      }
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
    let commands = ChatCommands(client: fixture.client, sync: ChatSync(client: fixture.client))
    defer { commands.closeFileCache() }
    let viewer = MessageAttachmentStore(commands: commands, didFail: { _ in })
    defer { viewer.close() }
    viewer.open(.init(id: "old", filename: "old.txt", contentType: "text/plain"))
    let retired = try XCTUnwrap(viewer.preview)
    let pending = try own(retired.store.get(retired.file))
    await fulfillment(of: [entered], timeout: 3)
    viewer.deactivate()
    XCTAssertNil(viewer.preview)
    continuation.yield(())
    viewer.open(.init(id: "new", filename: "new.txt", contentType: "text/plain"))
    let current = try await previewFile(in: viewer)
    XCTAssertEqual(viewer.preview?.attachment.id, "new")
    XCTAssertEqual(current.url.lastPathComponent, "new.txt")
    try await expectCancellation(pending)
    do {
      _ = try await retired.store.get(retired.file).value
      XCTFail("A retired presentation must not return its previous file")
    } catch { XCTAssertTrue(error is CancellationError) }
  }

  func testPreviousDetailCannotCancelReplacementAttachmentPreview() async throws {
    let server = try ChatFileHTTPServer { _ in .init(body: Data("current detail".utf8)) }
    addTeardownBlock { await server.stop() }
    let origin = try await server.start()
    let fixture = ConversationHistoryFixture(rows: [], fileOrigin: origin)
    let conversation = fixture.conversation()
    defer { conversation.close() }
    let previousOwner = UUID()
    let currentOwner = UUID()
    conversation.setDetailVisible(true, owner: previousOwner)
    conversation.setDetailVisible(true, owner: currentOwner)
    conversation.attachmentViewer.open(
      .init(id: "file", filename: "notes.txt", contentType: "text/plain"))
    let loaded = try await previewFile(in: conversation.attachmentViewer)
    let url = loaded.url
    conversation.setDetailVisible(false, owner: previousOwner)
    XCTAssertEqual(conversation.attachmentViewer.preview?.attachment.id, "file")
    XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
    conversation.setDetailVisible(false, owner: currentOwner)
    XCTAssertNil(conversation.attachmentViewer.preview)
    XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
  }

  func testFailedPreviewReadIsSharedUntilExplicitRetryRecoversIt() async throws {
    let offline = Mutex(true)
    let server = try ChatFileHTTPServer { _ in
      .init(headers: ["Cache-Control": "no-store"], body: Data("recovered".utf8))
    }
    addTeardownBlock { await server.stop() }
    let origin = try await server.start()
    let fixture = ChatHTTPFixture { request in
      guard request.httpMethod == "GET", request.url?.path == "/api/web/file-url" else {
        throw URLError(.unsupportedURL)
      }
      if offline.withLock({ $0 }) {
        return ChatHTTPResponse(status: 503, body: "{\"error\":{\"message\":\"Offline\"}}")
      }
      return ChatHTTPResponse(
        body: "{\"url\":\"\(origin)/file\",\"downloadUrl\":\"\(origin)/file\"}")
    }
    let commands = ChatCommands(client: fixture.client, sync: ChatSync(client: fixture.client))
    defer { commands.closeFileCache() }
    let viewer = MessageAttachmentStore(commands: commands, didFail: { _ in })
    defer { viewer.close() }
    viewer.open(.init(id: "retry", filename: "notes.txt", contentType: "text/plain"))
    let preview = try XCTUnwrap(viewer.preview)
    do {
      _ = try await preview.store.get(preview.file).value
      XCTFail("The original read must expose the failed response")
    } catch { XCTAssertEqual((error as? APIClientError)?.statusCode, 503) }
    offline.withLock { $0 = false }
    do {
      _ = try await preview.store.get(preview.file).value
      XCTFail("Observing the cached failure must not implicitly retry the request")
    } catch { XCTAssertEqual((error as? APIClientError)?.statusCode, 503) }
    preview.retry()
    let recovered = try await previewFile(in: viewer)
    XCTAssertEqual(try Data(contentsOf: recovered.url), Data("recovered".utf8))
    XCTAssertEqual(viewer.preview?.attachment.id, "retry")
  }

  func testReplacingAndDismissingPreviewsCancelTheirOriginalReads() async throws {
    let oldStarted = expectation(description: "Old preview requested authorization")
    let nextStarted = expectation(description: "Replacement preview requested authorization")
    let oldGate = AsyncStream<Void>.makeStream()
    let nextGate = AsyncStream<Void>.makeStream()
    defer {
      oldGate.continuation.finish()
      nextGate.continuation.finish()
    }
    let fixture = ChatHTTPFixture { request in
      guard request.httpMethod == "GET", let url = request.url,
        url.path == "/api/web/file-url"
      else { throw URLError(.unsupportedURL) }
      let id = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?
        .first(where: { $0.name == "file_id" })?.value
      switch id {
      case "old":
        oldStarted.fulfill()
        for await _ in oldGate.stream { break }
      case "next":
        nextStarted.fulfill()
        for await _ in nextGate.stream { break }
      default: throw URLError(.unsupportedURL)
      }
      return ChatHTTPResponse(status: 403, body: "{\"error\":{\"message\":\"Retired\"}}")
    }
    let commands = ChatCommands(client: fixture.client, sync: ChatSync(client: fixture.client))
    defer { commands.closeFileCache() }
    let viewer = MessageAttachmentStore(commands: commands, didFail: { _ in })
    defer { viewer.close() }
    viewer.open(.init(id: "old", filename: "old.txt", contentType: "text/plain"))
    let old = try XCTUnwrap(viewer.preview)
    let original = try own(old.store.get(old.file))
    await fulfillment(of: [oldStarted], timeout: 3)
    viewer.open(.init(id: "next", filename: "next.txt", contentType: "text/plain"))
    let next = try XCTUnwrap(viewer.preview)
    let replacement = try own(next.store.get(next.file))
    await fulfillment(of: [nextStarted], timeout: 3)
    viewer.dismiss()
    oldGate.continuation.finish()
    nextGate.continuation.finish()
    try await expectCancellation(original)
    try await expectCancellation(replacement)
    XCTAssertNil(viewer.preview)
  }

  func testUpgradeFailureCanCloseTheOwnerWithoutReenteringGraphEvaluation() async throws {
    let fixture = ChatHTTPFixture { request in
      guard request.httpMethod == "GET", request.url?.path == "/api/web/file-url" else {
        throw URLError(.unsupportedURL)
      }
      return ChatHTTPResponse(status: 426, body: "{\"error\":{\"message\":\"Upgrade required\"}}")
    }
    let commands = ChatCommands(client: fixture.client, sync: ChatSync(client: fixture.client))
    defer { commands.closeFileCache() }
    weak var owner: MessageAttachmentStore?
    let viewer = MessageAttachmentStore(commands: commands) { _ in owner?.close() }
    owner = viewer
    defer { viewer.close() }
    viewer.open(.init(id: "file", filename: "notes.txt", contentType: "text/plain"))
    let preview = try XCTUnwrap(viewer.preview)
    do {
      _ = try await preview.store.get(preview.file).value
      XCTFail("The upgrade response must reach the owning conversation")
    } catch { XCTAssertEqual((error as? APIClientError)?.statusCode, 426) }
    XCTAssertNil(viewer.preview)
  }

  private func previewFile(in viewer: MessageAttachmentStore) async throws -> ChatAttachmentFile {
    let preview = try XCTUnwrap(viewer.preview)
    let result = try await preview.store.get(preview.file).value
    return try XCTUnwrap(result)
  }

  private func previewURL(in viewer: MessageAttachmentStore) async throws -> URL {
    try await previewFile(in: viewer).url
  }

  private func own(_ task: Task<ChatAttachmentFile?, Error>) -> Task<ChatAttachmentFile?, Error> {
    addTeardownBlock {
      task.cancel()
      _ = await task.result
    }
    return task
  }

  private func expectCancellation(_ task: Task<ChatAttachmentFile?, Error>) async throws {
    do {
      _ = try await task.value
      XCTFail("A retired preview must cancel its original request")
    } catch {
      XCTAssertTrue(error is CancellationError || (error as? URLError)?.code == .cancelled)
    }
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
