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
    let firstPreview = try XCTUnwrap(original.artifacts.preview)
    let firstContent = try await firstPreview.store.get(firstPreview.content).value
    let firstFile = try XCTUnwrap(firstContent.file)
    XCTAssertTrue(
      try String(contentsOf: firstFile.url, encoding: .utf8).hasPrefix("Synthetic generated text"))
    original.artifacts.deactivate()
    replacement.artifacts.open(text)
    let nextPreview = try XCTUnwrap(replacement.artifacts.preview)
    let nextContent = try await nextPreview.store.get(nextPreview.content).value
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
    for (index, _) in images.enumerated() {
      let preview = try XCTUnwrap(viewer.preview)
      let content = try await preview.store.get(preview.content).value
      let file = try XCTUnwrap(content.file)
      let expectedName = index == 0 ? "Campaign study.png" : "Campaign alternate.png"
      XCTAssertEqual(content.artifact.filename, expectedName)
      XCTAssertEqual(
        try Data(contentsOf: file.url),
        try XCTUnwrap(fixture.files.first { $0.filename == expectedName }).bytes)
      XCTAssertEqual(viewer.canNavigateImage(-1, content: content), index > 0)
      XCTAssertEqual(viewer.canNavigateImage(1, content: content), index < images.count - 1)
      if index < images.count - 1 { viewer.navigateImage(1, content: content) }
    }
    viewer.dismiss()
    for name in ["json000001.json", "csv0000001.csv", "word000001.docx"] {
      let resource = try XCTUnwrap(viewer.resource("/artifacts/" + name))
      viewer.open(resource)
      let preview = try XCTUnwrap(viewer.preview)
      let content = try await preview.store.get(preview.content).value
      XCTAssertNotNil(content.file)
      if name == "json000001.json" { XCTAssertTrue(content.text?.text.contains("\n") == true) }
      if name == "csv0000001.csv" {
        XCTAssertEqual(
          content.text?.rows, [["Region", "Revenue"], ["North, coast", "120"], ["South", "180"]])
      }
      viewer.dismiss()
    }
    XCTAssertNil(viewer.preview)
  }

  func testUnavailableRetryAndLeavingDetailCancelResultOwnership() async throws {
    let fixture = try await GeneratedResultFixture.make(owner: self)
    let conversation = fixture.history.conversation()
    defer { conversation.close() }
    let viewer = conversation.artifacts
    let source = try XCTUnwrap(viewer.resource("/artifacts/text000001.txt"))
    fixture.state.denied.withLock { $0 = true }
    viewer.open(source)
    let deniedPreview = try XCTUnwrap(viewer.preview)
    let denied = await (try deniedPreview.store.get(deniedPreview.content)).result
    XCTAssertThrowsError(try denied.get()) { error in
      XCTAssertTrue(MessageArtifactStore.message(for: error).contains("permission"))
      XCTAssertFalse(ChatRequestFailure.canRetry(error))
    }
    fixture.state.denied.withLock { $0 = false }
    for status in [403, 404] {
      fixture.state.storageStatus.withLock { $0 = status }
      viewer.retry()
      let preview = try XCTUnwrap(viewer.preview)
      let result = await (try preview.store.get(preview.content)).result
      XCTAssertThrowsError(try result.get()) { error in
        XCTAssertTrue(
          MessageArtifactStore.message(for: error).contains(status == 403 ? "denied" : "deleted"))
        XCTAssertEqual(ChatRequestFailure.canRetry(error), status == 403)
      }
    }
    fixture.state.storageStatus.withLock { $0 = nil }
    viewer.retry()
    let preview = try XCTUnwrap(viewer.preview)
    let content = try await preview.store.get(preview.content).value
    let url = try XCTUnwrap(content.file?.url)
    viewer.deactivate()
    XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
    XCTAssertNil(viewer.preview)
    viewer.open(source)
    let current = try XCTUnwrap(viewer.preview)
    let currentContent = try await current.store.get(current.content).value
    XCTAssertEqual(currentContent.file?.url, url)
    viewer.close()
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
    let preview = try XCTUnwrap(viewer.preview)
    let content = try await preview.store.get(preview.content).value
    let file = try XCTUnwrap(content.file)
    let failedCatalog = await (try viewer.reads.store.get(viewer.reads.catalog)).result
    XCTAssertThrowsError(try failedCatalog.get()) { error in
      XCTAssertEqual((error as? APIClientError)?.statusCode, 503)
    }
    fixture.state.catalogUnavailable.withLock { $0 = false }
    viewer.refreshDetails()
    let recoveredCatalog = try await viewer.reads.store.get(viewer.reads.catalog).value
    XCTAssertFalse(recoveredCatalog.isEmpty)
    let retained = try await preview.store.get(preview.content).value
    XCTAssertEqual(retained.file?.url, file.url)
    XCTAssertEqual(viewer.reads.metadata(retained.artifact).filename, "Notes.txt")
  }

  func testShareConsumerKeepsAuthorizedFileAfterPreviewAndFileCacheClose() async throws {
    let fixture = try await GeneratedResultFixture.make(owner: self)
    let commands = ChatCommands(
      client: fixture.history.http.client, sync: ChatSync(client: fixture.history.http.client))
    let viewer = MessageArtifactStore(
      service: commands.artifacts, threadID: ConversationHistoryFixture.threadID,
      webURL: fixture.history.http.baseURL,
      markdown: MessageMarkdownCache(baseURL: fixture.history.http.baseURL),
      didFail: { XCTFail("Unexpected access failure: \($0)") })
    defer { viewer.close() }
    func openShare() async throws -> MessageArtifactStore.Share {
      viewer.open(try XCTUnwrap(viewer.resource("/artifacts/text000001.txt")))
      let preview = try XCTUnwrap(viewer.preview)
      let content = try await preview.store.get(preview.content).value
      let file = try XCTUnwrap(content.file)
      viewer.share(file, previewID: preview.id)
      return try XCTUnwrap(viewer.sharing)
    }
    var consumer: MessageArtifactStore.Share? = try await openShare()
    let url = try XCTUnwrap(consumer?.file.url)
    viewer.dismiss()
    viewer.close()
    commands.closeFileCache()
    XCTAssertNil(viewer.preview)
    XCTAssertNil(viewer.sharing)
    try withExtendedLifetime(consumer) {
      XCTAssertEqual(
        try String(contentsOf: url, encoding: .utf8),
        "Synthetic generated text\nRead, copy, share, or save to Files.")
    }
    consumer = nil
    XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
  }

  func testPreviewSizeRejectionDoesNotPreventFullFileSharing() async throws {
    let text = String(repeating: "A", count: 2 * 1024 * 1024 + 1)
    let fixture = try await GeneratedResultFixture.make(owner: self, text: text)
    let conversation = fixture.history.conversation()
    defer { conversation.close() }
    let viewer = conversation.artifacts
    viewer.open(try XCTUnwrap(viewer.resource("/artifacts/text000001.txt")))
    let preview = try XCTUnwrap(viewer.preview)
    let rejected = await (try preview.store.get(preview.content)).result
    XCTAssertThrowsError(try rejected.get()) { error in
      XCTAssertEqual((error as? URLError)?.code, .dataLengthExceedsMaximum)
    }
    viewer.downloadForSharing()
    let downloaded = try await preview.store.get(preview.download).value
    let file = try XCTUnwrap(downloaded)
    XCTAssertEqual(try String(contentsOf: file.url, encoding: .utf8), text)
    viewer.share(file, previewID: preview.id)
    XCTAssertEqual(viewer.sharing?.file.url, file.url)
    // The independent download does not erase the preview's useful size error.
    let stillRejected = await (try preview.store.get(preview.content)).result
    XCTAssertThrowsError(try stillRejected.get())
  }

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
