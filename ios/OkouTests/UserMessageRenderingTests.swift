import ChatDomain
import SwiftUI
import XCTest

@testable import Okou

@MainActor
final class UserMessageRenderingTests: XCTestCase {
  func testReusedRowsCannotCaptureATransientLayoutOutsideTheirNativeCell() async throws {
    let fixture = ConversationHistoryFixture(count: 30)
    let conversation = fixture.conversation()
    defer { conversation.close() }
    await conversation.refresh()
    let anchor = ConversationScrollAnchor()
    let rows = conversation.visibleMessages.filter { $0.role == .user }.map {
      ConversationCollectionRow.message(
        $0, showsAvatar: false, topSpacing: 0, pendingRetry: nil, isSending: false)
    }
    let host = UIHostingController(
      rootView: ConversationCollectionView(
        rows: rows, markdown: conversation.messageMarkdown, anchor: anchor,
        scroll: ConversationCollectionScroll(), followsBottom: false,
        phaseChanged: { _ in }, metricsChanged: { _ in }, refresh: {}
      ) { row, markerAnchor in
        if let message = row.message {
          UserMessageView(
            message: message, webURL: conversation.webURL,
            viewer: conversation.attachmentViewer, loadsAttachments: false
          )
          .background {
            if let markerAnchor {
              ConversationRowAnchor(messageID: message.id, anchor: markerAnchor)
            }
          }
          .padding(20)
        }
      })
    let window = try await mountConversationHost(host)
    defer { unmount(window) }
    let marker = try XCTUnwrap(
      markers(in: host.view).first {
        anchor.capture(messageID: $0.messageID) != nil
      })
    let collection = try XCTUnwrap(marker.enclosingScrollView as? UICollectionView)
    let original = marker.bounds
    let captured = try XCTUnwrap(anchor.capture(messageID: marker.messageID))
    // Reused SwiftUI content briefly receives a narrow proposal before its measured
    // cell is laid out. Its overflowing text must not become the saved viewport.
    marker.bounds.size = CGSize(width: 1, height: collection.bounds.height * 4)
    XCTAssertNil(anchor.capture(messageID: marker.messageID))
    marker.bounds = original
    let restored = try XCTUnwrap(anchor.capture(messageID: marker.messageID))
    XCTAssertEqual(restored.messageID, captured.messageID)
    XCTAssertEqual(restored.offset, captured.offset, accuracy: 1)
  }

  func testUserTextIsLiteralAndReferencesKeepTheirInlineOrderAndLinks() async throws {
    let fixture = ConversationHistoryFixture(rows: [
      row(
        1,
        parts: """
          [{"type":"text","text":"**Keep this literal**: https://example.com and "},
           {"type":"agent","nameSnapshot":"Scout","agentId":"\(ConversationHistoryFixture.agentID)"},
           {"type":"text","text":" from "},
           {"type":"chat_thread","titleSnapshot":"Earlier chat","threadId":"\(ConversationHistoryFixture.threadID)"},
           {"type":"text","text":" using "},
           {"type":"template","titleSnapshot":"Editorial","template":{"type":"illustration","selection":{"illustrationStyleId":"editorial"}}}]
          """)
    ])
    let conversation = fixture.conversation()
    defer { conversation.close() }
    await conversation.refresh()
    let message = try XCTUnwrap(conversation.messages.first)
    let document = try XCTUnwrap(message.userMessage)
    let text = UserMessageInlineText(parts: document.bodyParts, webURL: fixture.http.baseURL)
      .content
    XCTAssertEqual(
      String(text.characters),
      "**Keep this literal**: https://example.com and Scout from Earlier chat using Editorial")
    XCTAssertEqual(
      text.runs.compactMap(\.link),
      [
        URL(string: "https://example.com"),
        fixture.http.baseURL.appending(path: "agents/\(ConversationHistoryFixture.agentID)/chat"),
        fixture.http.baseURL.appending(path: "chats/\(ConversationHistoryFixture.threadID)"),
      ].compactMap { $0 })
    XCTAssertEqual(message.copyText, String(text.characters))

    let literal =
      "Bare example.com, user@example.com, ftp://files.example.com/a.txt, "
      + "ahttps://example.com/one and 3https://example.com/two stay text."
    let unlinked = UserMessageInlineText(
      parts: [.init(type: "text", text: literal)], webURL: fixture.http.baseURL
    ).content
    XCTAssertEqual(String(unlinked.characters), literal)
    XCTAssertTrue(unlinked.runs.allSatisfy { $0.link == nil })
  }

  func testNativeTranscriptKeepsStructuredOnlyRowsAndItsPositionAfterRefresh() async throws {
    let fixture = ConversationHistoryFixture(rows: [
      row(
        1,
        parts:
          #"[{"type":"source","kind":"slack","href":"https://example.slack.com/archives/C1/p1"},{"type":"text","text":"Please review the release plan."}]"#
      ),
      row(
        2, type: "input.automation",
        parts: """
          [{"type":"automation","workflowName":"Morning Brief","workflowId":"\(ConversationHistoryFixture.agentID)","automationBrief":"Summarize the work waiting for today."}]
          """),
      row(
        3,
        parts:
          #"[{"type":"feedback","quote":"The release starts tomorrow.","note":[{"type":"text","text":"Please explain this part."}]}]"#
      ),
      row(
        4,
        parts:
          #"[{"type":"template","titleSnapshot":"Editorial style","template":{"type":"illustration","selection":{"illustrationStyleId":"editorial"}}}]"#
      ),
      row(
        5,
        parts:
          #"[{"type":"source","kind":"mcp","clientId":"research","clientName":"Research client"},{"type":"text","text":"Review the linked document."}]"#
      ),
      row(
        6,
        parts: """
          [{"type":"text","text":"Ask "},{"type":"agent","agentId":"\(ConversationHistoryFixture.agentID)","nameSnapshot":"Release Scout"},{"type":"text","text":" \(String(repeating: "Additional context for a long conversation. ", count: 40))"}]
          """),
    ])
    fixture.append(row(7, type: "run.completed", parts: "[]"))
    let conversation = fixture.conversation()
    defer { conversation.close() }
    await conversation.refresh()
    XCTAssertNil(conversation.error)
    XCTAssertEqual(conversation.messages.count, 6)
    conversation.rememberReadingPosition(
      ConversationReadingPosition(messageID: ConversationHistoryFixture.id(1), offset: 0))
    let host = UIHostingController(rootView: ChatDetailView(conversation: conversation))
    let window = try await mountConversationHost(host)
    defer { unmount(window) }
    let collection = try XCTUnwrap(
      markers(in: host.view).first?.enclosingScrollView as? UICollectionView)
    let dataSource = try XCTUnwrap(
      collection.dataSource as? UICollectionViewDiffableDataSource<Int, String>)
    try await eventually {
      dataSource.snapshot().itemIdentifiers == (1...6).map(ConversationHistoryFixture.id)
        + ["conversation-bottom"]
    }
    await stableHostingGeometry(host.view)
    try await savedReadingPositionMatchesViewport(conversation, in: host.view)
    let position = try XCTUnwrap(conversation.readingPosition)
    capture(host, named: "Structured user messages - light")
    window.overrideUserInterfaceStyle = .dark
    await stableHostingGeometry(host.view)
    capture(host, named: "Structured user messages - dark")

    fixture.append(row(8, parts: #"[{"type":"text","text":"A later message arrived."}]"#))
    await conversation.refresh()
    try await eventually {
      dataSource.snapshot().itemIdentifiers.contains(ConversationHistoryFixture.id(8))
    }
    try await savedReadingPositionMatchesViewport(conversation, in: host.view)
    XCTAssertEqual(conversation.readingPosition?.messageID, position.messageID)
    XCTAssertEqual(
      conversation.readingPosition?.offset ?? .infinity, position.offset, accuracy: 1)
  }

  private func row(_ sequence: Int, type: String = "input.prompt", parts: String) -> String {
    let payload =
      type == "run.completed" ? "{}" : "{\"userMessage\":{\"version\":1,\"parts\":\(parts)}}"
    return """
      {"id":"\(ConversationHistoryFixture.id(sequence))","chatThreadId":"\(ConversationHistoryFixture.threadID)","runId":"70000000-0000-4000-8000-000000000001","seqId":\(sequence),"createdAt":"2026-10-20T00:00:00Z","eventType":"\(type)","payload":\(payload)}
      """
  }

  private func capture<V: View>(_ host: UIHostingController<V>, named name: String) {
    let image = UIGraphicsImageRenderer(size: host.view.bounds.size).image { _ in
      host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true)
    }
    let attachment = XCTAttachment(image: image)
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
