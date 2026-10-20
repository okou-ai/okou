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
  func testNativeImageVideoPDFAndUnsupportedPreviewPresentation() async throws {
    let image = UIGraphicsImageRenderer(size: CGSize(width: 640, height: 360)).pngData { context in
      UIColor.systemTeal.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 640, height: 360))
      ("Native image preview" as NSString).draw(
        at: CGPoint(x: 100, y: 150),
        withAttributes: [
          .font: UIFont.systemFont(ofSize: 36, weight: .semibold), .foregroundColor: UIColor.white,
        ])
    }
    let pdf = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 400, height: 500)).pdfData {
      context in
      context.beginPage()
      ("Project brief\n\nNative PDF attachment preview.\nLocal acceptance fixture." as NSString)
        .draw(
          in: CGRect(x: 30, y: 40, width: 340, height: 400),
          withAttributes: [.font: UIFont.systemFont(ofSize: 22)])
    }
    let movieURL = try XCTUnwrap(
      Bundle(for: Self.self).url(forResource: "attachment-preview", withExtension: "mp4"))
    let movie = try Data(contentsOf: movieURL)
    let server = try ChatFileHTTPServer { request in
      switch request.url?.path {
      case "/image": .init(headers: ["Content-Type": "image/png"], body: image)
      case "/movie": .init(headers: ["Content-Type": "video/mp4"], body: movie)
      case "/pdf": .init(headers: ["Content-Type": "application/pdf"], body: pdf)
      default: .init(body: Data("Local unsupported format".utf8))
      }
    }
    let origin = try await server.start()
    defer { server.stop() }
    let fixture = ConversationHistoryFixture(
      rows: [try attachmentRow(1, text: "Review the image, recording and project brief.")],
      fileOrigin: origin)
    let conversation = fixture.conversation()
    defer { conversation.close() }
    await conversation.refresh()
    let host = UIHostingController(rootView: ChatDetailView(conversation: conversation))
    let window = try await mountConversationHost(host)
    defer { unmount(window) }
    let collection = try XCTUnwrap(markers(in: host.view).first?.enclosingScrollView)
    _ = collection.accessibilityScroll(.up)
    await stableHostingGeometry(host.view)
    window.overrideUserInterfaceStyle = .light
    await stableHostingGeometry(host.view)
    attachScreenshot(window, name: "Attachments-light")
    window.overrideUserInterfaceStyle = .dark
    host.view.layoutIfNeeded()
    await stableHostingGeometry(host.view)
    attachScreenshot(window, name: "Attachments-dark")
    for attachment in conversation.messages[0].attachments {
      conversation.attachmentViewer.open(attachment)
      try await eventually { conversation.attachmentViewer.preview?.file != nil }
      let file = try XCTUnwrap(conversation.attachmentViewer.preview?.file)
      if attachment.id == "other" {
        XCTAssertFalse(QLPreviewController.canPreview(file.url as NSURL))
        try await eventually { host.presentedViewController?.view.window != nil }
      } else {
        XCTAssertTrue(QLPreviewController.canPreview(file.url as NSURL))
        try await eventually {
          guard let preview = previewController(in: host) else { return false }
          return preview.view.window != nil && preview.transitionCoordinator == nil
            && preview.presentingViewController?.transitionCoordinator == nil
        }
      }
      host.presentedViewController?.view.layoutIfNeeded()
      if attachment.id == "other" { attachScreenshot(window, name: "Unsupported-file") }
      host.presentedViewController?.dismiss(animated: false)
      conversation.attachmentViewer.dismiss()
      try await eventually { host.presentedViewController == nil }
    }
  }

  func testHistoryAndSQLiteReopenKeepFileOnlyAndMixedAttachments() async throws {
    let fixture = ConversationHistoryFixture(rows: [
      try attachmentRow(1, text: ""), try attachmentRow(2, text: "Review these files"),
    ])
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let scope = ChatCacheScope(
      apiBaseURL: fixture.http.baseURL, userID: "reader", workspaceID: "workspace")
    let conversation = fixture.conversation(cache: ChatCache(scope: scope, directory: directory))
    await conversation.refresh()
    XCTAssertNil(conversation.error)
    XCTAssertEqual(conversation.messages.map(\.text), ["", "Review these files"])
    XCTAssertEqual(
      conversation.messages.first?.attachments.map(\.id), ["image", "movie", "pdf", "other"])
    let expected = conversation.messages
    conversation.close()
    let sync = ChatSync(
      client: fixture.http.client, cache: ChatCache(scope: scope, directory: directory))
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

  func testLoadedThumbnailsPreviewDismissalAndCellReusePreserveHistoryPosition() async throws {
    let renderer = UIGraphicsImageRenderer(size: CGSize(width: 320, height: 180))
    let png = renderer.pngData { context in
      UIColor.systemTeal.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 320, height: 180))
    }
    let downloaded = Mutex(0)
    let server = try ChatFileHTTPServer { _ in
      downloaded.withLock { $0 += 1 }
      return .init(headers: ["Content-Type": "image/png"], body: png)
    }
    let origin = try await server.start()
    defer { server.stop() }
    let fixture = ConversationHistoryFixture(
      rows: try (1...25).map { try attachmentRow($0, text: "Message \($0)") }, fileOrigin: origin)
    let conversation = fixture.conversation()
    defer { conversation.close() }
    await conversation.refresh()
    while conversation.hasEarlierMessages { await conversation.loadEarlierMessages() }
    conversation.rememberReadingPosition(
      .init(messageID: ConversationHistoryFixture.id(20), offset: -40))
    let host = UIHostingController(rootView: ChatDetailView(conversation: conversation))
    let window = try await mountConversationHost(host)
    defer { unmount(window) }
    try await eventually { downloaded.withLock { $0 > 0 } }
    await stableHostingGeometry(host.view)
    try await savedReadingPositionMatchesViewport(conversation, in: host.view)
    let scroll = try XCTUnwrap(markers(in: host.view).first?.enclosingScrollView)
    let size = scroll.contentSize
    let position = try XCTUnwrap(conversation.readingPosition)
    let attachment = try XCTUnwrap(conversation.messages.first?.attachments.first)
    conversation.attachmentViewer.open(attachment)
    try await eventually {
      guard let preview = previewController(in: host) else { return false }
      return preview.view.window != nil && preview.transitionCoordinator == nil
    }
    conversation.attachmentViewer.dismiss()
    try await eventually { host.presentedViewController == nil }
    await stableHostingGeometry(host.view)
    XCTAssertEqual(scroll.contentSize.height, size.height, accuracy: 1)
    XCTAssertEqual(
      try XCTUnwrap(offset(of: position.messageID, in: host.view)), position.offset, accuracy: 1)
    for direction: UIAccessibilityScrollDirection in [.up, .down, .up, .down] {
      let before = scroll.contentOffset.y
      XCTAssertTrue(scroll.accessibilityScroll(direction))
      try await eventually { abs(scroll.contentOffset.y - before) > 1 }
      await stableHostingGeometry(host.view)
      try await savedReadingPositionMatchesViewport(conversation, in: host.view)
      XCTAssertEqual(scroll.contentSize.height, size.height, accuracy: 1)
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

@MainActor
private func attachScreenshot(_ window: UIWindow, name: String) {
  let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
    window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
  }
  let attachment = XCTAttachment(image: image)
  attachment.name = name
  attachment.lifetime = .keepAlways
  XCTContext.runActivity(named: name) { $0.add(attachment) }
}
