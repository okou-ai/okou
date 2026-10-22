import ChatData
import ChatDataTestSupport
import ChatDomain
import QuickLook
import SwiftUI
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class GeneratedResultTests: XCTestCase {
  func testMarkdownSemanticsKeepInlineLinksCodeAndActionCardsInOrder() async throws {
    let fixture = try await GeneratedResultFixture.make()
    defer { fixture.server.stop() }
    let conversation = fixture.history.conversation()
    defer { conversation.close() }
    let markdown = conversation.messageMarkdown
    let source = """
      Before **the result**. Read [the brief](/artifacts/pdf0000001.pdf) alongside [a normal link](https://example.com/report.pdf).

      ![Campaign image](/artifacts/image00001.png)

      After the image, `![example](/artifacts/word000001.docx)` stays code.

      ```markdown
      ![Example](/artifacts/slides0001.pptx)
      ```

      [Connect Slack](/connectors/slack/connect?agentId=\(ConversationHistoryFixture.agentID)&threadId=\(ConversationHistoryFixture.threadID)&callbackPrompt=Continue)

      ![Project brief](/artifacts/word000001.docx)

      Final paragraph.
      """
    let content = await markdown.content(for: source)
    let actions = MessageActionBody.blocks(
      content, webURL: fixture.history.http.baseURL,
      agentID: ConversationHistoryFixture.agentID, threadID: ConversationHistoryFixture.threadID)
    XCTAssertEqual(actions.filter { if case .connector = $0 { true } else { false } }.count, 1)
    var resources: [ChatArtifact] = []
    var prose = ""
    for case .markdown(let fragment) in actions {
      for block in MessageArtifactBody.blocks(fragment, viewer: conversation.artifacts) {
        switch block {
        case .artifact(let resource, _, _): resources.append(resource)
        case .markdown(let fragment): prose += String(fragment.characters)
        }
      }
    }
    XCTAssertEqual(resources.map(\.filename), ["image00001.png", "word000001.docx"])
    XCTAssertTrue(prose.contains("Before the result"))
    XCTAssertTrue(prose.contains("After the image"))
    XCTAssertTrue(prose.contains("![Example](/artifacts/slides0001.pptx)"))
    XCTAssertTrue(prose.contains("Final paragraph"))
    XCTAssertTrue(content.runs.contains { $0.link?.host == "example.com" })
    XCTAssertTrue(content.runs.contains { $0.link?.path == "/artifacts/pdf0000001.pdf" })
    let styled = await markdown.content(for: "![**Bold** label](/artifacts/image00001.png)")
    XCTAssertEqual(MessageArtifactBody.blocks(styled, viewer: conversation.artifacts).count, 1)
    let linked = await markdown.content(
      for: "[![Thumb](/artifacts/image00001.png)](https://example.com)")
    let linkedBlocks = MessageArtifactBody.blocks(linked, viewer: conversation.artifacts)
    XCTAssertTrue(
      linkedBlocks.contains {
        if case .artifact(_, _, let destination) = $0 {
          destination?.host == "example.com"
        } else {
          false
        }
      })
  }

  func testLoadingCardsAndRefreshingKeepTranscriptGeometry() async throws {
    let fixture = try await GeneratedResultFixture.make()
    defer { fixture.server.stop() }
    let conversation = fixture.history.conversation()
    defer { conversation.close() }
    await conversation.refresh()
    XCTAssertNil(conversation.error)
    let host = UIHostingController(rootView: ChatDetailView(conversation: conversation))
    let window = try await mountConversationHost(host)
    defer { unmount(window) }
    let scroll = try XCTUnwrap(markers(in: host.view).first?.enclosingScrollView)
    let size = scroll.contentSize
    try await eventually { fixture.state.resolutions.withLock { $0 >= 4 } }
    await stableHostingGeometry(host.view)
    XCTAssertEqual(scroll.contentSize.height, size.height, accuracy: 1)
    _ = scroll.accessibilityScroll(.down)
    await stableHostingGeometry(host.view)
    let before = scroll.contentOffset
    await conversation.refresh()
    await stableHostingGeometry(host.view)
    XCTAssertEqual(scroll.contentOffset.y, before.y, accuracy: 1)
    XCTAssertEqual(conversation.messages.last?.text, fixture.message)
  }

  func testReusedCardResolvesReplacedResourceAndReplacementScope() async throws {
    let first = try await GeneratedResultFixture.make()
    let second = try await GeneratedResultFixture.make()
    defer {
      first.server.stop()
      second.server.stop()
    }
    let original = first.history.conversation()
    let replacement = second.history.conversation()
    defer {
      original.close()
      replacement.close()
    }
    let image = try XCTUnwrap(original.artifacts.resource("/artifacts/image00001.png"))
    let video = try XCTUnwrap(original.artifacts.resource("/artifacts/video00001.mp4"))
    @MainActor func content(_ resource: ChatArtifact, viewer: MessageArtifactStore) -> some View {
      ScrollView {
        MessageArtifactCard(
          resource: resource, label: resource.filename, destination: nil,
          images: [], imageSources: [], viewer: viewer, loadsContent: true
        ).padding(20)
      }
    }
    let host = UIHostingController(rootView: content(image, viewer: original.artifacts))
    let window = try await mountResultHost(host)
    defer { unmount(window) }
    try await eventually {
      first.state.storageRequests.withLock {
        $0.contains { $0.url?.lastPathComponent == "image00001.png" }
      }
    }
    host.rootView = content(video, viewer: original.artifacts)
    try await eventually {
      first.state.storageRequests.withLock {
        $0.contains { $0.url?.lastPathComponent == "poster0001.png" }
      }
    }
    original.artifacts.deactivate()
    host.rootView = content(video, viewer: replacement.artifacts)
    try await eventually {
      second.state.storageRequests.withLock {
        $0.contains { $0.url?.lastPathComponent == "poster0001.png" }
      }
    }
    XCTAssertGreaterThan(second.state.resolutions.withLock { $0 }, 0)
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
    let host = UIHostingController(
      rootView: MessageArtifactPreview(viewer: viewer, markdown: conversation.messageMarkdown))
    let window = try await mountResultHost(host)
    defer { unmount(window) }
    viewer.open(images[0], images: images)
    for (index, image) in images.enumerated() {
      try await eventually {
        viewer.preview?.file != nil && viewer.preview?.artifact.source == image.source
      }
      let file = try XCTUnwrap(viewer.preview?.file)
      try await eventually {
        guard let controller = previewController(in: host),
          controller.view.window != nil, let source = controller.dataSource,
          source.numberOfPreviewItems(in: controller) == 1
        else { return false }
        return source.previewController(controller, previewItemAt: 0).previewItemURL == file.url
      }
      XCTAssertEqual(viewer.canNavigateImage(-1), index > 0)
      XCTAssertEqual(viewer.canNavigateImage(1), index < images.count - 1)
      if index < images.count - 1 { viewer.navigateImage(1) }
    }
    viewer.dismiss()
    for name in ["json000001.json", "csv0000001.csv"] {
      let resource = try XCTUnwrap(viewer.resource("/artifacts/" + name))
      viewer.open(resource)
      try await eventually { viewer.preview?.file != nil || viewer.preview?.error != nil }
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
    try await eventually { viewer.preview?.error != nil }
    XCTAssertTrue(viewer.preview?.error?.contains("permission") == true)
    fixture.state.denied.withLock { $0 = false }
    for status in [403, 404] {
      fixture.state.storageStatus.withLock { $0 = status }
      viewer.retry()
      try await eventually { viewer.preview?.error != nil }
      XCTAssertTrue(viewer.preview?.error?.contains(status == 403 ? "denied" : "deleted") == true)
    }
    fixture.state.storageStatus.withLock { $0 = nil }
    viewer.retry()
    try await eventually { viewer.preview?.file != nil }
    let url = try XCTUnwrap(viewer.preview?.file?.url)
    viewer.deactivate()
    XCTAssertNil(viewer.preview)
    try await eventually { !FileManager.default.fileExists(atPath: url.path) }
    viewer.open(source)
    try await eventually { viewer.preview?.file != nil }
    let current = try XCTUnwrap(viewer.preview?.file?.url)
    viewer.close()
    XCTAssertNil(viewer.preview)
    viewer.open(source)
    XCTAssertNil(viewer.preview)
    try await eventually { !FileManager.default.fileExists(atPath: current.path) }
  }
  func testVideoWithoutRecordedPosterLoadsAFrameOnDemand() async throws {
    let fixture = try await GeneratedResultFixture.make()
    defer { fixture.server.stop() }
    let conversation = fixture.history.conversation()
    defer { conversation.close() }
    fixture.state.omitVideoPoster.withLock { $0 = true }
    let resource = try XCTUnwrap(conversation.artifacts.resource("/artifacts/video00001.mp4"))
    let card = try await conversation.artifacts.card(resource, thumbnail: true)
    XCTAssertNotNil(card.thumbnail.flatMap(UIImage.init(data:)))
    XCTAssertEqual(card.artifact.kind, .video)
  }

  func testShareConsumerKeepsAuthorizedFileAfterPreviewDismissal() async throws {
    let fixture = try await GeneratedResultFixture.make()
    defer { fixture.server.stop() }
    let conversation = fixture.history.conversation()
    defer { conversation.close() }
    let viewer = conversation.artifacts
    viewer.open(try XCTUnwrap(viewer.resource("/artifacts/text000001.txt")))
    try await eventually { viewer.preview?.file != nil }
    viewer.share()
    var consumer = viewer.sharing
    let url = try XCTUnwrap(consumer?.file.url)
    viewer.dismiss()
    XCTAssertNil(viewer.preview)
    XCTAssertNil(viewer.sharing)
    withExtendedLifetime(consumer) {
      XCTAssertEqual(
        try String(contentsOf: url, encoding: .utf8),
        "Synthetic generated text\nRead, copy, share, or save to Files.")
    }
    consumer = nil
    try await eventually { !FileManager.default.fileExists(atPath: url.path) }
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
    try await eventually { viewer.preview?.file != nil }
    XCTAssertEqual(viewer.preview?.text?.text, "New detail scope")
    let url = try XCTUnwrap(viewer.preview?.file?.url)
    viewer.dismiss()
    try await eventually { !FileManager.default.fileExists(atPath: url.path) }
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

  private init(
    history: ConversationHistoryFixture, server: ChatFileHTTPServer,
    state: GeneratedResultState, message: String
  ) {
    self.history = history
    self.server = server
    self.state = state
    self.message = message
  }

  @MainActor static func make() async throws -> GeneratedResultFixture {
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
        bytes: Data("Synthetic generated text\nRead, copy, share, or save to Files.".utf8)),
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
      history: history, server: server, state: state, message: message)
  }
}

@MainActor private func previewController(in controller: UIViewController) -> QLPreviewController? {
  (controller as? QLPreviewController)
    ?? controller.children.lazy.compactMap { previewController(in: $0) }.first
}

private final class GeneratedResultState: Sendable {
  let storageStatus = Mutex<Int?>(nil)
  let omitVideoPoster = Mutex(false)
  let denied = Mutex(false)
  let resolutions = Mutex(0)
  let storageRequests = Mutex<[URLRequest]>([])
}

@MainActor private func mountResultHost<V: View>(_ host: UIHostingController<V>) async throws
  -> UIWindow
{
  let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
  let window = UIWindow(windowScene: scene)
  window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
  window.rootViewController = host
  window.makeKeyAndVisible()
  host.view.layoutIfNeeded()
  try await eventually { host.view.window != nil && !host.view.bounds.isEmpty }
  await hostingPresentationFrame()
  return window
}
