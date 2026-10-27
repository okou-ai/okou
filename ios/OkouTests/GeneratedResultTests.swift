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
    let first = try await GeneratedResultFixture.make()
    defer { first.server.stop() }
    let second = try await GeneratedResultFixture.make(text: "Result owned by the second workspace")
    defer { second.server.stop() }
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
    try await waitForBusinessResult { original.artifacts.preview?.file != nil }
    let firstFile = try XCTUnwrap(original.artifacts.preview?.file)
    XCTAssertTrue(
      try String(contentsOf: firstFile.url, encoding: .utf8).hasPrefix("Synthetic generated text"))
    original.artifacts.deactivate()
    replacement.artifacts.open(text)
    try await waitForBusinessResult { replacement.artifacts.preview?.file != nil }
    let nextFile = try XCTUnwrap(replacement.artifacts.preview?.file)
    XCTAssertEqual(
      try String(contentsOf: nextFile.url, encoding: .utf8), "Result owned by the second workspace")
  }

  func testImageNavigationAndStructuredTextPreviewsKeepAuthorizedContent() async throws {
    let fixture = try await GeneratedResultFixture.make()
    defer { fixture.server.stop() }
    let conversation = fixture.history.conversation()
    defer { conversation.close() }
    let viewer = conversation.artifacts
    let images = try ["image00001.png", "image00002.png"].map {
      try XCTUnwrap(viewer.resource("/artifacts/" + $0))
    }
    viewer.open(images[0], images: images)
    for (index, image) in images.enumerated() {
      try await waitForBusinessResult {
        viewer.preview?.file != nil && viewer.preview?.artifact.source == image.source
      }
      let file = try XCTUnwrap(viewer.preview?.file)
      let expectedName = index == 0 ? "Campaign study.png" : "Campaign alternate.png"
      XCTAssertEqual(viewer.preview?.artifact.filename, expectedName)
      XCTAssertEqual(
        try Data(contentsOf: file.url),
        try XCTUnwrap(fixture.files.first { $0.filename == expectedName }).bytes)
      XCTAssertEqual(viewer.canNavigateImage(-1), index > 0)
      XCTAssertEqual(viewer.canNavigateImage(1), index < images.count - 1)
      if index < images.count - 1 { viewer.navigateImage(1) }
    }
    viewer.dismiss()
    for name in ["json000001.json", "csv0000001.csv"] {
      let resource = try XCTUnwrap(viewer.resource("/artifacts/" + name))
      viewer.open(resource)
      try await waitForBusinessResult {
        viewer.preview?.file != nil || viewer.preview?.error != nil
      }
      XCTAssertNil(viewer.preview?.error, name)
      let preview = try XCTUnwrap(viewer.preview)
      if name == "json000001.json" { XCTAssertTrue(preview.text?.text.contains("\n") == true) }
      if name == "csv0000001.csv" {
        XCTAssertEqual(
          preview.text?.rows, [["Region", "Revenue"], ["North, coast", "120"], ["South", "180"]])
      }
      viewer.dismiss()
    }
    XCTAssertNil(viewer.preview)
  }

  func testUnavailableRetryAndLeavingDetailCancelResultOwnership() async throws {
    let fixture = try await GeneratedResultFixture.make()
    defer { fixture.server.stop() }
    let conversation = fixture.history.conversation()
    defer { conversation.close() }
    let viewer = conversation.artifacts
    let source = try XCTUnwrap(viewer.resource("/artifacts/text000001.txt"))
    fixture.state.denied.withLock { $0 = true }
    viewer.open(source)
    try await waitForBusinessResult { viewer.preview?.error != nil }
    XCTAssertTrue(viewer.preview?.error?.contains("permission") == true)
    fixture.state.denied.withLock { $0 = false }
    for status in [403, 404] {
      fixture.state.storageStatus.withLock { $0 = status }
      viewer.retry()
      try await waitForBusinessResult { viewer.preview?.error != nil }
      XCTAssertTrue(viewer.preview?.error?.contains(status == 403 ? "denied" : "deleted") == true)
    }
    fixture.state.storageStatus.withLock { $0 = nil }
    viewer.retry()
    try await waitForBusinessResult { viewer.preview?.file != nil }
    let url = try XCTUnwrap(viewer.preview?.file?.url)
    try await waitForFileRemoval(at: url) { viewer.deactivate() }
    XCTAssertNil(viewer.preview)
    viewer.open(source)
    try await waitForBusinessResult { viewer.preview?.file != nil }
    let current = try XCTUnwrap(viewer.preview?.file?.url)
    try await waitForFileRemoval(at: current) { viewer.close() }
    XCTAssertNil(viewer.preview)
    viewer.open(source)
    XCTAssertNil(viewer.preview)
  }

  func testShareConsumerKeepsAuthorizedFileAfterPreviewDismissal() async throws {
    let fixture = try await GeneratedResultFixture.make()
    defer { fixture.server.stop() }
    let conversation = fixture.history.conversation()
    defer { conversation.close() }
    let viewer = conversation.artifacts
    viewer.open(try XCTUnwrap(viewer.resource("/artifacts/text000001.txt")))
    try await waitForBusinessResult { viewer.preview?.file != nil }
    viewer.share()
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
    try await waitForFileRemoval(at: url) { consumer = nil }
  }

  func testLeavingDetailCancelsPendingAuthorizationAndCannotPublishIntoReentry() async throws {
    let entered = expectation(description: "Artifact authorization started")
    let (stream, continuation) = AsyncStream<Void>.makeStream()
    defer { continuation.finish() }
    let first = Mutex(true)
    let server = try ChatFileHTTPServer { _ in .init(body: Data("New detail scope".utf8)) }
    let origin = try await server.start()
    defer { server.stop() }
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
    await fulfillment(of: [entered], timeout: 3)
    viewer.deactivate()
    continuation.yield(())
    XCTAssertNil(viewer.preview)
    viewer.open(resource)
    try await waitForBusinessResult { viewer.preview?.file != nil }
    XCTAssertEqual(viewer.preview?.text?.text, "New detail scope")
    let url = try XCTUnwrap(viewer.preview?.file?.url)
    try await waitForFileRemoval(at: url) { viewer.dismiss() }
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
  let server: ChatFileHTTPServer
  let state: GeneratedResultState
  let message: String
  let files: [GeneratedResultFile]

  private init(
    history: ConversationHistoryFixture, server: ChatFileHTTPServer,
    state: GeneratedResultState, message: String, files: [GeneratedResultFile]
  ) {
    self.history = history
    self.server = server
    self.state = state
    self.message = message
    self.files = files
  }

  @MainActor static func make(
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
      history: history, server: server, state: state, message: message, files: files)
  }
}

private final class GeneratedResultState: Sendable {
  let storageStatus = Mutex<Int?>(nil)
  let omitVideoPoster = Mutex(false)
  let denied = Mutex(false)
  let resolutions = Mutex(0)
  let storageRequests = Mutex<[URLRequest]>([])
}
