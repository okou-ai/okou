import CCState
import ChatData
import ChatDataTestSupport
import ChatDomain
import Synchronization
import UIKit
import XCTest

@testable import Okou

@MainActor
final class GeneratedResultTests: XCTestCase {

  func testReplacingResultResourcesAndScopesUsesTheirOwnAuthorizedContent() async throws {
    let first = try await GeneratedResultFixture.make(owner: self)
    let second = try await GeneratedResultFixture.make(
      owner: self, text: "Result owned by the second workspace")
    let original = first.history.conversation()
    let replacement = second.history.conversation()
    defer {
      original.close()
      replacement.close()
    }
    let image = try XCTUnwrap(original.artifacts.resource("/artifacts/image00001.png"))
    let video = try XCTUnwrap(original.artifacts.resource("/artifacts/video00001.mp4"))
    let imageCard = try await original.artifacts.card(image, thumbnail: false)
    XCTAssertEqual(imageCard.artifact.filename, "Campaign study.png")
    let videoCard = try await original.artifacts.card(video, thumbnail: false)
    XCTAssertEqual(videoCard.artifact.filename, "Campaign recording.mp4")
    let text = try XCTUnwrap(original.artifacts.resource("/artifacts/text000001.txt"))
    original.artifacts.open(text)
    let firstContent = try await artifactPreviewTask(original.artifacts).value
    let firstFile = try XCTUnwrap(firstContent.file)
    XCTAssertTrue(
      try String(contentsOf: firstFile.url, encoding: .utf8).hasPrefix("Synthetic generated text"))
    original.artifacts.deactivate()
    replacement.artifacts.open(text)
    let nextContent = try await artifactPreviewTask(replacement.artifacts).value
    let nextFile = try XCTUnwrap(nextContent.file)
    XCTAssertEqual(
      try String(contentsOf: nextFile.url, encoding: .utf8), "Result owned by the second workspace")
  }

  func testImageNavigationAndStructuredTextPreviewsKeepAuthorizedContent() async throws {
    let fixture = try await GeneratedResultFixture.make(owner: self)
    let conversation = fixture.history.conversation()
    defer { conversation.close() }
    let viewer = conversation.artifacts
    let images = try ["image00001.png", "image00002.png"].map {
      try XCTUnwrap(viewer.resource("/artifacts/" + $0))
    }
    viewer.open(images[0], images: images)
    for (index, image) in images.enumerated() {
      let presentation = try XCTUnwrap(viewer.preview)
      let content = try await artifactPreviewTask(viewer).value
      let file = try XCTUnwrap(content.file)
      let expectedName = index == 0 ? "Campaign study.png" : "Campaign alternate.png"
      XCTAssertEqual(content.artifact.source, image.source)
      XCTAssertEqual(content.artifact.filename, expectedName)
      XCTAssertEqual(
        try Data(contentsOf: file.url),
        try XCTUnwrap(fixture.files.first { $0.filename == expectedName }).bytes)
      XCTAssertEqual(content.image(-1) != nil, index > 0)
      XCTAssertEqual(content.image(1) != nil, index < images.count - 1)
      if index < images.count - 1 {
        viewer.navigateImage(1, content: content, previewID: presentation.id)
      }
    }
    viewer.dismiss()
    for name in ["json000001.json", "csv0000001.csv", "word000001.docx"] {
      let resource = try XCTUnwrap(viewer.resource("/artifacts/" + name))
      viewer.open(resource)
      let content = try await artifactPreviewTask(viewer).value
      if name == "json000001.json" { XCTAssertTrue(content.text?.text.contains("\n") == true) }
      if name == "csv0000001.csv" {
        XCTAssertEqual(
          content.text?.rows, [["Region", "Revenue"], ["North, coast", "120"], ["South", "180"]])
      }
      if name == "word000001.docx" {
        let file = try XCTUnwrap(content.file)
        XCTAssertEqual(
          try Data(contentsOf: file.url), fixture.files.first { $0.reference == name }?.bytes)
      }
      viewer.dismiss()
    }
    XCTAssertNil(viewer.preview)
  }

  func testVideoPreviewDoesNotWaitForAFullDownloadAndSharingStillSavesTheFile() async throws {
    let fixture = try await GeneratedResultFixture.make(owner: self)
    let conversation = fixture.history.conversation()
    defer { conversation.close() }
    let viewer = conversation.artifacts
    let video = try XCTUnwrap(viewer.resource("/artifacts/video00001.mp4"))
    // An unavailable full-file transfer must not prevent opening the native streaming player.
    fixture.state.storageStatus.withLock { $0 = 503 }
    viewer.open(video)
    let preview = try XCTUnwrap(viewer.preview)
    let content = try await artifactPreviewTask(viewer).value
    let url = try XCTUnwrap(content.contentURL)
    XCTAssertEqual(content.artifact.kind, .video)
    XCTAssertEqual(url.lastPathComponent, "video00001.mp4")
    XCTAssertNil(content.file)
    XCTAssertTrue(fixture.state.storageRequests.withLock { $0.isEmpty })

    fixture.state.storageStatus.withLock { $0 = nil }
    viewer.downloadForSharing(previewID: preview.id)
    let downloaded = try await preview.store.get(preview.download).value
    let file = try XCTUnwrap(downloaded)
    viewer.share(file, previewID: preview.id)
    let shared = try XCTUnwrap(viewer.sharing)
    viewer.dismiss()
    XCTAssertEqual(
      try Data(contentsOf: shared.file.url),
      try XCTUnwrap(fixture.files.first { $0.reference == "video00001.mp4" }).bytes)
    let request = try XCTUnwrap(fixture.state.storageRequests.withLock { $0.first })
    XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
    XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
  }

  func testVideoPreviewRequiresAuthorizationAndRetryObtainsANewPlaybackAddress() async throws {
    let fixture = try await GeneratedResultFixture.make(owner: self)
    let conversation = fixture.history.conversation()
    defer { conversation.close() }
    let viewer = conversation.artifacts
    let video = try XCTUnwrap(viewer.resource("/artifacts/video00001.mp4"))
    fixture.state.denied.withLock { $0 = true }
    viewer.open(video)
    let denied = await (try artifactPreviewTask(viewer)).result
    XCTAssertThrowsError(try denied.get()) { error in
      XCTAssertEqual((error as? APIClientError)?.statusCode, 403)
    }

    fixture.state.denied.withLock { $0 = false }
    viewer.retry()
    let first = try await artifactPreviewTask(viewer).value
    let originalURL = try XCTUnwrap(first.contentURL)
    // Retrying a failed/expired stream reauthorizes instead of reusing its signed URL.
    viewer.retry()
    let retried = try await artifactPreviewTask(viewer).value
    let freshURL = try XCTUnwrap(retried.contentURL)
    XCTAssertNotEqual(freshURL, originalURL)
    XCTAssertEqual(freshURL.lastPathComponent, originalURL.lastPathComponent)
    XCTAssertTrue(fixture.state.storageRequests.withLock { $0.isEmpty })
  }

  func testUnavailableRetryAndLeavingDetailCancelResultOwnership() async throws {
    let fixture = try await GeneratedResultFixture.make(owner: self)
    let conversation = fixture.history.conversation()
    defer { conversation.close() }
    let viewer = conversation.artifacts
    let source = try XCTUnwrap(viewer.resource("/artifacts/text000001.txt"))
    fixture.state.denied.withLock { $0 = true }
    viewer.open(source)
    let denied = await (try artifactPreviewTask(viewer)).result
    XCTAssertThrowsError(try denied.get()) { error in
      XCTAssertTrue(MessageArtifactStore.message(for: error).contains("permission"))
      XCTAssertFalse(ChatRequestFailure.canRetry(error))
    }
    fixture.state.denied.withLock { $0 = false }
    for status in [403, 404] {
      fixture.state.storageStatus.withLock { $0 = status }
      viewer.retry()
      let rejected = await (try artifactPreviewTask(viewer)).result
      XCTAssertThrowsError(try rejected.get()) { error in
        XCTAssertTrue(
          MessageArtifactStore.message(for: error).contains(status == 403 ? "denied" : "deleted"))
        XCTAssertEqual(ChatRequestFailure.canRetry(error), status == 403)
      }
    }
    fixture.state.storageStatus.withLock { $0 = nil }
    viewer.retry()
    let content = try await artifactPreviewTask(viewer).value
    let url = try XCTUnwrap(content.file?.url)
    viewer.deactivate()
    XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
    XCTAssertNil(viewer.preview)
    viewer.open(source)
    let currentContent = try await artifactPreviewTask(viewer).value
    let current = try XCTUnwrap(currentContent.file?.url)
    viewer.close()
    XCTAssertTrue(FileManager.default.fileExists(atPath: current.path))
    XCTAssertNil(viewer.preview)
    viewer.open(source)
    XCTAssertNil(viewer.preview)
  }

  func testFileDetailsRetryKeepsTheAlreadyDownloadedContent() async throws {
    let fixture = try await GeneratedResultFixture.make(owner: self)
    fixture.state.catalogUnavailable.withLock { $0 = true }
    let conversation = fixture.history.conversation()
    defer { conversation.close() }
    let viewer = conversation.artifacts
    viewer.open(try XCTUnwrap(viewer.resource("/artifacts/text000001.txt")))
    let content = try await artifactPreviewTask(viewer).value
    let file = try XCTUnwrap(content.file)
    let failedCatalog = await (try viewer.reads.store.get(viewer.reads.catalog)).result
    XCTAssertThrowsError(try failedCatalog.get()) { error in
      XCTAssertEqual((error as? APIClientError)?.statusCode, 503)
    }
    let requests = fixture.state.storageRequests.withLock { $0.count }
    let resolutions = fixture.state.resolutions.withLock { $0 }
    fixture.state.catalogUnavailable.withLock { $0 = false }
    viewer.refreshDetails()
    let recoveredCatalog = try await viewer.reads.store.get(viewer.reads.catalog).value
    XCTAssertFalse(recoveredCatalog.isEmpty)
    let retained = try await artifactPreviewTask(viewer).value
    XCTAssertEqual(retained.file?.url, file.url)
    XCTAssertEqual(viewer.reads.metadata(retained.artifact).filename, "Notes.txt")
    XCTAssertEqual(fixture.state.storageRequests.withLock { $0.count }, requests)
    XCTAssertEqual(fixture.state.resolutions.withLock { $0 }, resolutions)
  }

  func testShareConsumerKeepsAuthorizedFileAfterPreviewDismissal() async throws {
    let fixture = try await GeneratedResultFixture.make(owner: self)
    let conversation = fixture.history.conversation()
    defer { conversation.close() }
    let viewer = conversation.artifacts
    viewer.open(try XCTUnwrap(viewer.resource("/artifacts/text000001.txt")))
    let presentation = try XCTUnwrap(viewer.preview)
    let content = try await artifactPreviewTask(viewer).value
    viewer.share(try XCTUnwrap(content.file), previewID: presentation.id)
    var consumer = viewer.sharing
    let url = try XCTUnwrap(consumer?.file.url)
    viewer.dismiss()
    XCTAssertNil(viewer.preview)
    XCTAssertNil(viewer.sharing)
    try withExtendedLifetime(consumer) {
      XCTAssertEqual(
        try String(contentsOf: url, encoding: .utf8),
        "Synthetic generated text\nRead, copy, share, or save to Files.")
    }
    consumer = nil
    viewer.open(try XCTUnwrap(viewer.resource("/artifacts/text000001.txt")))
    let reopened = try await artifactPreviewTask(viewer).value
    XCTAssertEqual(reopened.file?.url, url)
  }

  func testLeavingDetailCancelsPendingAuthorizationAndCannotPublishIntoReentry() async throws {
    let entered = expectation(description: "Artifact authorization started")
    let (stream, continuation) = AsyncStream<Void>.makeStream()
    defer { continuation.finish() }
    let first = Mutex(true)
    let server = try ChatFileHTTPServer { _ in .init(body: Data("New detail scope".utf8)) }
    addTeardownBlock { await server.stop() }
    let origin = try await server.start()
    let fixture = ChatHTTPFixture { request in
      if request.url?.path.hasSuffix("/artifacts") == true {
        return ChatHTTPResponse(body: "{\"runs\":[]}")
      }
      let waits = first.withLock { value in
        let result = value
        value = false
        return result
      }
      if waits {
        entered.fulfill()
        for await _ in stream { break }
      }
      return ChatHTTPResponse(
        body: """
          {"url":"\(origin)/content","downloadUrl":"\(origin)/file","filename":"Notes.txt","contentType":"text/plain"}
          """)
    }
    let commands = ChatCommands(client: fixture.client, sync: ChatSync(client: fixture.client))
    let markdown = MessageMarkdownCache(baseURL: fixture.baseURL)
    let viewer = MessageArtifactStore(
      service: commands.artifacts, threadID: "thread", webURL: fixture.baseURL,
      markdown: markdown, didFail: { _ in XCTFail("Cancellation must not expire the account") })
    defer { viewer.close() }
    let resource = try XCTUnwrap(viewer.resource("/artifacts/text000001.txt"))
    viewer.open(resource)
    let old = try artifactPreviewTask(viewer)
    addTeardownBlock {
      continuation.finish()
      old.cancel()
      _ = await old.result
      fixture.session.invalidateAndCancel()
      commands.artifacts.closeFileCache()
    }
    await fulfillment(of: [entered], timeout: 3)
    viewer.deactivate()
    continuation.yield(())
    let retired = await old.result
    XCTAssertThrowsError(try retired.get())
    XCTAssertNil(viewer.preview)
    viewer.open(resource)
    let current = try await artifactPreviewTask(viewer).value
    XCTAssertEqual(current.text?.text, "New detail scope")
    let url = try XCTUnwrap(current.file?.url)
    viewer.dismiss()
    XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
  }

  func testTextPreviewLimitDoesNotDisableIndependentFullFileSharing() async throws {
    let text = String(repeating: "Full authorized file\n", count: 120_000)
    let fixture = try await GeneratedResultFixture.make(owner: self, text: text)
    let conversation = fixture.history.conversation()
    defer { conversation.close() }
    let viewer = conversation.artifacts
    viewer.open(try XCTUnwrap(viewer.resource("/artifacts/text000001.txt")))
    let preview = try XCTUnwrap(viewer.preview)
    let rejected = await (try artifactPreviewTask(viewer)).result
    XCTAssertThrowsError(try rejected.get()) { error in
      XCTAssertEqual((error as? URLError)?.code, .dataLengthExceedsMaximum)
    }
    fixture.state.denied.withLock { $0 = true }
    viewer.downloadForSharing(previewID: preview.id)
    let denied = await (try preview.store.get(preview.download)).result
    XCTAssertThrowsError(try denied.get()) { error in
      XCTAssertEqual((error as? APIClientError)?.statusCode, 403)
    }
    fixture.state.denied.withLock { $0 = false }
    viewer.downloadForSharing(previewID: preview.id, retry: true)
    let downloaded = try await preview.store.get(preview.download).value
    let file = try XCTUnwrap(downloaded)
    viewer.share(file, previewID: preview.id)
    let consumer = try XCTUnwrap(viewer.sharing)
    viewer.dismiss()
    try withExtendedLifetime(consumer) {
      XCTAssertEqual(try String(contentsOf: consumer.file.url, encoding: .utf8), text)
    }
    // A retired presentation cannot reuse its previously authorized result to open another share.
    viewer.share(file, previewID: preview.id)
    XCTAssertNil(viewer.sharing)
  }
}

@MainActor
func artifactPreviewTask(_ viewer: MessageArtifactStore) throws -> Task<
  MessageArtifactPreviewRead.Content, Error
> {
  let preview = try XCTUnwrap(viewer.preview)
  return try preview.store.get(preview.value)
}

private struct GeneratedResultFile: Sendable {
  let reference: String
  let filename: String
  let type: String
  let bytes: Data
  var artifactKind: String? = nil
}

private final class GeneratedResultFixture: Sendable {
  let history: ConversationHistoryFixture
  let state: GeneratedResultState
  let message: String
  let files: [GeneratedResultFile]

  private init(
    history: ConversationHistoryFixture,
    state: GeneratedResultState, message: String, files: [GeneratedResultFile]
  ) {
    self.history = history
    self.state = state
    self.message = message
    self.files = files
  }

  @MainActor static func make(
    owner: XCTestCase,
    text: String = "Synthetic generated text\nRead, copy, share, or save to Files."
  ) async throws -> GeneratedResultFixture {
    let image = UIGraphicsImageRenderer(size: CGSize(width: 800, height: 500)).pngData { context in
      UIColor.systemIndigo.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 800, height: 500))
      UIColor.systemTeal.setFill()
      context.fill(CGRect(x: 80, y: 80, width: 180, height: 340))
      ("Campaign study" as NSString).draw(
        at: CGPoint(x: 310, y: 210),
        withAttributes: [
          .font: UIFont.systemFont(ofSize: 38, weight: .bold), .foregroundColor: UIColor.white,
        ])
    }
    func bundled(_ name: String, _ ext: String) throws -> Data {
      try Data(
        contentsOf: XCTUnwrap(
          Bundle(for: GeneratedResultTests.self).url(forResource: name, withExtension: ext)))
    }
    let html = """
      <!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'><style>body{font:20px system-ui;background:#18322f;color:#fff;margin:32px}button{font:18px system-ui;padding:12px 24px;border-radius:12px}h1{margin-top:100px}</style></head><body><p>Quarterly review</p><h1 id='slide'>Slide 1</h1><p>Synthetic interactive HTML presentation.</p><button id='next' onclick="document.getElementById('slide').textContent='Slide 2';location.hash='slide-2'">Next slide</button></body></html>
      """
    let files: [GeneratedResultFile] = [
      .init(
        reference: "image00001.png", filename: "Campaign study.png", type: "image/png", bytes: image
      ),
      .init(
        reference: "image00002.png", filename: "Campaign alternate.png", type: "image/png",
        bytes: image),
      .init(reference: "poster0001.png", filename: "Poster.png", type: "image/png", bytes: image),
      .init(
        reference: "word000001.docx", filename: "Project brief.docx",
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        bytes: try bundled("generated-result", "docx")),
      .init(
        reference: "sheet00001.xlsx", filename: "Regional results.xlsx",
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        bytes: try bundled("generated-result", "xlsx")),
      .init(
        reference: "video00001.mp4", filename: "Campaign recording.mp4", type: "video/mp4",
        bytes: try bundled("attachment-preview", "mp4")),
      .init(
        reference: "text000001.txt", filename: "Notes.txt", type: "text/plain",
        bytes: Data(text.utf8)),
      .init(
        reference: "json000001.json", filename: "Results.json", type: "application/json",
        bytes: Data("{\"region\":\"North\",\"revenue\":120}".utf8)),
      .init(
        reference: "csv0000001.csv", filename: "Regional results.csv", type: "text/csv",
        bytes: Data("Region,Revenue\r\n\"North, coast\",120\r\nSouth,180\r\n".utf8)),
      .init(
        reference: "html000001.html", filename: "Quarterly review.html", type: "text/html",
        bytes: Data(html.utf8), artifactKind: "presentation-html"),
    ]
    let state = GeneratedResultState()
    let server = try ChatFileHTTPServer { request in
      state.storageRequests.withLock { $0.append(request) }
      if let status = state.storageStatus.withLock({ $0 }) { return .init(status: status) }
      guard let file = files.first(where: { request.url?.lastPathComponent == $0.reference }) else {
        return .init(status: 404)
      }
      if let header = request.value(forHTTPHeaderField: "Range"),
        let range = header.wholeMatch(of: #/bytes=([0-9]+)-([0-9]*)/#),
        let start = Int(range.1), start < file.bytes.count
      {
        let end = min(Int(range.2) ?? (file.bytes.count - 1), file.bytes.count - 1)
        guard end >= start else { return .init(status: 416) }
        return .init(
          status: 206,
          headers: [
            "Content-Type": file.type,
            "Accept-Ranges": "bytes", "Content-Range": "bytes \(start)-\(end)/\(file.bytes.count)",
          ],
          body: file.bytes.subdata(in: start..<(end + 1)))
      }
      return .init(
        headers: ["Content-Type": file.type, "Accept-Ranges": "bytes"], body: file.bytes)
    }
    owner.addTeardownBlock { await server.stop() }
    let origin = try await server.start()
    let catalog = try String(
      decoding: JSONSerialization.data(withJSONObject: [
        "runs": [
          [
            "runId": "run",
            "files": files.map { file -> [String: Any] in
              var object: [String: Any] = [
                "id": file.reference, "url": "/artifacts/" + file.reference,
                "filename": file.filename, "contentType": file.type, "size": file.bytes.count,
                "createdAt": "2026-10-21T00:00:00Z",
              ]
              if let kind = file.artifactKind { object["artifactKind"] = kind }
              return object
            },
          ]
        ]
      ]), as: UTF8.self)
    let message = """
      ## Your results

      ![Campaign study](/artifacts/image00001.png)

      ![Project brief](/artifacts/word000001.docx)

      ![Regional results](/artifacts/sheet00001.xlsx)

      ![Quarterly review](/artifacts/html000001.html)

      Read [the PDF brief](/artifacts/pdf0000001.pdf), or visit [the reference](https://example.com).
      """
    let payload = String(decoding: try JSONEncoder().encode(["content": message]), as: UTF8.self)
    let row = """
      {"id":"\(ConversationHistoryFixture.id(1))","chatThreadId":"\(ConversationHistoryFixture.threadID)","runId":null,"revokesEventId":null,"contextType":null,"contextId":null,"runEventSequenceNumber":null,"runEventId":null,"seqId":1,"createdAt":"2026-10-21T00:00:00Z","eventType":"output.message","payload":\(payload)}
      """
    let history = ConversationHistoryFixture(
      rows: [row],
      artifactResources: { request in
        if request.url?.path.hasSuffix("/artifacts") == true {
          if state.catalogUnavailable.withLock({ $0 }) {
            return ChatHTTPResponse(status: 503, body: "{\"error\":{\"message\":\"Unavailable\"}}")
          }
          return ChatHTTPResponse(body: catalog)
        }
        let resolution = state.resolutions.withLock {
          $0 += 1
          return $0
        }
        if state.denied.withLock({ $0 }) {
          return ChatHTTPResponse(status: 403, body: "{\"error\":{\"message\":\"Forbidden\"}}")
        }
        guard let file = files.first(where: { request.url?.lastPathComponent == $0.reference })
        else { return ChatHTTPResponse(status: 404, body: "{\"error\":{\"message\":\"Deleted\"}}") }
        let contentURL = origin.appendingPathComponent(file.reference).appending(queryItems: [
          URLQueryItem(name: "signature", value: String(resolution))
        ])
        var body: [String: String] = [
          "url": contentURL.absoluteString,
          "downloadUrl": contentURL.absoluteString,
          "filename": file.filename, "contentType": file.type, "expiresAt": "2026-10-21T00:00:00Z",
        ]
        if (file.type == "video/mp4" && !state.omitVideoPoster.withLock({ $0 }))
          || file.type == "text/html"
        {
          body["previewImageUrl"] = "/artifacts/poster0001.png"
        }
        return ChatHTTPResponse(
          body: String(decoding: try JSONEncoder().encode(body), as: UTF8.self))
      })
    return GeneratedResultFixture(
      history: history, state: state, message: message, files: files)
  }
}

private final class GeneratedResultState: Sendable {
  let catalogUnavailable = Mutex(false)
  let storageStatus = Mutex<Int?>(nil)
  let omitVideoPoster = Mutex(false)
  let denied = Mutex(false)
  let resolutions = Mutex(0)
  let storageRequests = Mutex<[URLRequest]>([])
}
