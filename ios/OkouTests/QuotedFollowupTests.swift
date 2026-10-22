import ChatData
import ChatDataTestSupport
import ChatDomain
import SwiftUI
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class QuotedFollowupTests: XCTestCase {
  func testNativeQuoteActionPreservesSelectionAndFocusesAnIndependentNote() async throws {
    let fixture = AttachmentFlowFixture()
    let conversation = fixture.conversation()
    defer { conversation.close() }
    conversation.draft = "Keep the ordinary draft."
    let message = output("👋 First paragraph.\n\n  Selected 🌷 é passage.  \n\nLast paragraph.")
    let host = UIHostingController(
      rootView: QuoteHarness(conversation: conversation, message: message))
    let window = try await mount(host)
    defer { unmount(window) }
    try await eventually {
      self.textViews(in: window).contains { $0.accessibilityIdentifier == "message-selection-text" }
    }
    let selection = try XCTUnwrap(
      textViews(in: window).first { $0.accessibilityIdentifier == "message-selection-text" })
    selection.becomeFirstResponder()
    let range = (message.text as NSString).range(of: "  Selected 🌷 é passage.  ")
    selection.selectedRange = range
    await hostingPresentationFrame()
    attach(window, name: "Native assistant text selection")
    let menu = try XCTUnwrap(
      selection.delegate?.textView?(
        selection, editMenuForTextIn: range, suggestedActions: []))
    let quote = try XCTUnwrap(
      menu.children.compactMap { $0 as? UIAction }.first { $0.title == "Quote" })
    let control = UIControl()
    control.addAction(quote, for: .primaryActionTriggered)
    control.sendActions(for: .primaryActionTriggered)
    try await eventually {
      self.textViews(in: window).contains {
        $0.accessibilityLabel == "Ask or comment on this quote" && $0.isFirstResponder
      }
    }
    let note = try XCTUnwrap(
      textViews(in: window).first { $0.accessibilityLabel == "Ask or comment on this quote" })
    note.insertText("Explain this.")
    try await eventually {
      conversation.composer.editorBlocks.first(where: \.isFeedback)?.content.text == "Explain this."
    }
    note.undoManager?.undo()
    try await eventually {
      conversation.composer.editorBlocks.first(where: \.isFeedback)?.content.text == ""
    }
    note.setMarkedText("拼音", selectedRange: NSRange(location: 2, length: 0))
    try await eventually { note.markedTextRange != nil }
    note.unmarkText()
    try await eventually {
      conversation.composer.editorBlocks.first(where: \.isFeedback)?.content.text == "拼音"
    }
    XCTAssertEqual(conversation.draft, "Keep the ordinary draft.")
    XCTAssertTrue(fixture.state.value.withLock { $0.messages.isEmpty })
    let second = try XCTUnwrap(
      ChatFeedbackSelection(
        message: output("Second quote"), range: NSRange(location: 0, length: 12)))
    let secondID = try XCTUnwrap(conversation.composer.addFeedback(second))
    try await eventually {
      self.textViews(in: window).contains {
        $0.accessibilityIdentifier == "feedback-note-\(secondID)" && $0.isFirstResponder
      }
    }
    let secondNote = try XCTUnwrap(
      textViews(in: window).first { $0.accessibilityIdentifier == "feedback-note-\(secondID)" })
    secondNote.insertText("Independent comment")
    try await eventually {
      conversation.composer.editorBlocks.filter(\.isFeedback).last?.content.text
        == "Independent comment"
    }
    attach(window, name: "Native ordered quotes and independent notes")
    conversation.composer.removeFeedback(secondID)
    XCTAssertEqual(
      conversation.composer.editorBlocks.filter(\.isFeedback).map(\.content.text), ["拼音"])
    XCTAssertEqual(conversation.draft, "Keep the ordinary draft.")
    let remaining = try XCTUnwrap(conversation.composer.editorBlocks.first(where: \.isFeedback))
    conversation.composer.removeFeedback(remaining.id)
    try await eventually {
      !conversation.composer.document.hasFeedback
        && self.textViews(in: host.view).contains {
          $0.accessibilityIdentifier == "message-input" && $0.isFirstResponder
            && $0.text == "Keep the ordinary draft."
        }
    }
    let plain = try XCTUnwrap(
      textViews(in: host.view).first { $0.accessibilityIdentifier == "message-input" })
    plain.insertText(" Continue here.")
    try await eventually { conversation.draft.contains("Continue here.") }
    XCTAssertEqual(conversation.composer.document.parts.count, 1)
    XCTAssertFalse(conversation.composer.document.hasFeedback)
  }

  func testQuoteWithoutNoteSendsStructuredContentAndRetriesTheSameEvent() async throws {
    let fixture = AttachmentFlowFixture(failSend: true)
    let conversation = fixture.conversation()
    defer { conversation.close() }
    let message = output("Prefix 🌷 selected passage")
    let selection = try XCTUnwrap(
      ChatFeedbackSelection(
        message: message,
        range: (message.text as NSString).range(of: "selected passage")))
    conversation.composer.addFeedback(selection)
    XCTAssertTrue(conversation.composer.hasContent)
    await conversation.send()
    let pending = try XCTUnwrap(conversation.pending.first)
    XCTAssertTrue(pending.needsRetry)
    XCTAssertFalse(conversation.composer.hasContent)
    conversation.draft = "New work while retrying"
    await conversation.retry(pending)
    let writes = fixture.state.value.withLock { $0.messages }
    XCTAssertEqual(writes.count, 2)
    let first = try JSONDecoder().decode(Send.self, from: writes[0])
    let retried = try JSONDecoder().decode(Send.self, from: writes[1])
    let evidence = XCTAttachment(
      data: try JSONEncoder().encode(first.userMessage), uniformTypeIdentifier: "public.json")
    evidence.name = "Canonical native quoted userMessage"
    evidence.lifetime = .keepAlways
    add(evidence)
    XCTAssertTrue(first.hasTextContent)
    XCTAssertEqual(first.clientEventId, retried.clientEventId)
    XCTAssertEqual(first.userMessage, ChatDraftDocument(parts: [selection.part]))
    XCTAssertEqual(retried.userMessage, first.userMessage)
    XCTAssertEqual(conversation.draft, "New work while retrying")
    XCTAssertTrue(conversation.pending.isEmpty)
    XCTAssertNil(conversation.error)
    let durable = try XCTUnwrap(
      conversation.history?.messages.first(where: { $0.id == first.clientEventId })?.userMessage?
        .parts.first
    )
    XCTAssertEqual(durable.quote, selection.quote)
    XCTAssertEqual(durable.note, [])
    XCTAssertEqual(durable.eventId, message.id)
    XCTAssertEqual(durable.range?.start, selection.range.location)
  }

  func testCurrentConversationOwnsQuotesAndDisplaysTheDurableStructuredMessage() async throws {
    let fixture = QuoteHistoryFixture()
    let conversation = fixture.conversation()
    defer { conversation.close() }
    await conversation.refresh()
    let message = try XCTUnwrap(conversation.messages.first(where: { $0.role == .assistant }))
    let first = try XCTUnwrap(
      ChatFeedbackSelection(
        message: message, range: (message.text as NSString).range(of: "Review the final evidence")))
    let second = try XCTUnwrap(
      ChatFeedbackSelection(
        message: message, range: (message.text as NSString).range(of: "Keep the owner visible")))
    conversation.draft = "Keep the existing draft."
    conversation.quote(first)
    let firstNote = try XCTUnwrap(conversation.composer.editorBlocks.first(where: \.isFeedback))
    conversation.composer.editBlock(firstNote.id, text: "Which evidence is still missing?")
    conversation.quote(second)
    let host = UIHostingController(rootView: ChatDetailView(conversation: conversation))
    let window = try await mount(host)
    defer { unmount(window) }
    try await eventually {
      self.textViews(in: host.view).filter {
        $0.accessibilityLabel == "Ask or comment on this quote"
      }.count == 2
    }
    try await eventually { markers(in: host.view).contains { $0.messageID == message.id } }
    await stableHostingGeometry(host.view)
    try await eventually {
      self.textViews(in: host.view).contains {
        $0.accessibilityLabel == "Ask or comment on this quote" && $0.isFirstResponder
          && $0.bounds.height > 30
      }
    }
    await hostingPresentationFrame()
    attach(window, name: "Conversation with native quoted follow-up composer")
    let unrelatedFixture = AttachmentFlowFixture()
    let unrelated = unrelatedFixture.conversation()
    unrelated.quote(first)
    XCTAssertFalse(unrelated.composer.hasContent)
    unrelated.close()
    // Canonically equal Swift strings can have different UTF-16 offsets.
    let changed = ChatMessage(
      id: message.id, role: .assistant,
      text: message.text.replacingOccurrences(of: "Café", with: "Cafe\u{0301}"),
      createdAt: message.createdAt, isQueued: false, isError: false)
    XCTAssertEqual(changed.text, message.text)
    XCTAssertNotEqual(changed.text.utf16.count, message.text.utf16.count)
    conversation.quote(
      try XCTUnwrap(
        ChatFeedbackSelection(
          message: changed, range: NSRange(location: 0, length: changed.text.utf16.count))))
    XCTAssertEqual(conversation.composer.editorBlocks.filter(\.isFeedback).count, 2)
    await conversation.send()
    try await eventually {
      conversation.messages.contains {
        $0.userMessage?.parts.contains(where: { $0.type == "feedback" }) == true
      }
    }
    let sent = try XCTUnwrap(fixture.state.value.withLock { $0.document })
    XCTAssertEqual(sent.parts.map { $0["type"]?.string }, ["text", "feedback", "feedback"])
    XCTAssertEqual(sent.parts[1]["eventId"]?.string, message.id)
    let evidence = XCTAttachment(
      data: try JSONEncoder().encode(sent), uniformTypeIdentifier: "public.json")
    evidence.name = "Native mixed quoted userMessage for PWA decoding"
    evidence.lifetime = .keepAlways
    add(evidence)
    let sentID = try XCTUnwrap(fixture.state.value.withLock { $0.eventID })
    try await eventually {
      !conversation.isLoading && markers(in: host.view).contains { $0.messageID == sentID }
    }
    await stableHostingGeometry(host.view)
    attach(window, name: "Durable structured quotes rendered in native conversation")
    conversation.close()
    conversation.quote(first)
    XCTAssertFalse(conversation.composer.hasContent)
  }

  private struct Send: Decodable {
    let clientEventId: String
    let userMessage: ChatDraftDocument
    let hasTextContent: Bool
  }

  private func output(_ text: String) -> ChatMessage {
    ChatMessage(
      id: "assistant-event", role: .assistant, text: text, createdAt: Date(), isQueued: false,
      isError: false)
  }
  private func mount<V: View>(_ host: UIHostingController<V>) async throws -> UIWindow {
    let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
    let window = UIWindow(windowScene: scene)
    window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
    window.rootViewController = host
    window.makeKeyAndVisible()
    try await eventually { !self.textViews(in: host.view).isEmpty }
    return window
  }
  private func textViews(in view: UIView) -> [UITextView] {
    if let input = view as? UITextView { return [input] }
    return view.subviews.flatMap { textViews(in: $0) }
  }
  private func attach(_ window: UIWindow, name: String) {
    let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
      window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
    }
    let attachment = XCTAttachment(image: image)
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}

private struct QuoteHarness: View {
  let conversation: ConversationStore
  let message: ChatMessage
  @State private var selecting = true
  @State private var pendingQuote: ChatFeedbackSelection?
  var body: some View {
    ChatComposerView(
      draft: Binding(get: { conversation.draft }, set: { conversation.draft = $0 }),
      isBusy: false, showsProgress: false, canStop: false, needsUpgrade: false,
      error: nil, attachmentURL: URL(string: "https://app.example.invalid")!,
      attachments: conversation.attachmentDraft, draftState: conversation.composer,
      submit: { await conversation.send() }, refresh: nil
    )
    .sheet(
      isPresented: $selecting,
      onDismiss: {
        if let pendingQuote { conversation.composer.addFeedback(pendingQuote) }
        pendingQuote = nil
      },
      content: {
        MessageTextSelectionSheet(text: message.text, message: message) {
          pendingQuote = $0
          selecting = false
        }
      })
  }
}

private final class QuoteHistoryFixture: Sendable {
  struct State: Sendable {
    var document: ChatDraftDocument?
    var eventID: String?
  }
  final class Shared: Sendable { let value = Mutex(State()) }
  let state = Shared()
  let http: ChatHTTPFixture
  static let threadID = "45000000-0000-4000-8000-000000000001"
  static let agentID = "45000000-0000-4000-8000-000000000002"
  static let outputID = "45000000-0000-4000-8000-000000000003"

  init() {
    let state = self.state
    http = ChatHTTPFixture { request in
      let path = request.url!.path
      switch path {
      case let path where path.hasSuffix("/event-snapshot"):
        return ChatHTTPResponse(
          status: 404,
          body: #"{"error":{"code":"CHAT_EVENT_SNAPSHOT_NOT_FOUND","message":"No snapshot"}}"#)
      case let path where path.hasSuffix("/event-rows"):
        let after =
          URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first {
            $0.name == "sinceSeqId"
          }?.value.flatMap(Int.init) ?? 0
        let output =
          "Review the final evidence before release. Café status.\n\nKeep the owner visible for each stage."
        let content = String(decoding: try JSONEncoder().encode(output), as: UTF8.self)
        var rows: [String] = []
        if after < 1 {
          rows.append(
            """
            {"id":"\(Self.outputID)","chatThreadId":"\(Self.threadID)","seqId":1,"eventType":"output.message","createdAt":"2026-10-20T10:00:00Z","payload":{"content":\(content)}}
            """)
        }
        let current = state.value.withLock { $0 }
        if let document = current.document, let id = current.eventID, after < 2 {
          let value = String(decoding: try JSONEncoder().encode(document), as: UTF8.self)
          rows.append(
            """
            {"id":"\(id)","chatThreadId":"\(Self.threadID)","seqId":2,"eventType":"input.prompt","createdAt":"2026-10-20T10:01:00Z","payload":{"userMessage":\(value)}}
            """)
        }
        return ChatHTTPResponse(
          body: """
            {"rows":[\(rows.joined(separator: ","))],"cursor":{"lastEventId":"\(current.eventID ?? Self.outputID)","lastSeqId":\(current.eventID == nil ? 1 : 2)},"hasMore":false}
            """)
      case let path where path.hasSuffix("/connector-selections"):
        return ChatHTTPResponse(body: #"{"selections":[]}"#)
      case let path where path.hasSuffix("/metadata"):
        return ChatHTTPResponse(
          body: """
            {"id":"\(Self.threadID)","agentId":"\(Self.agentID)","computerUseHostId":null,"cloudBrowserEnabled":false}
            """)
      case "/api/chat/events":
        struct Input: Decodable {
          let clientEventId: String
          let userMessage: ChatDraftDocument
        }
        let input = try JSONDecoder().decode(Input.self, from: chatRequestBody(request))
        state.value.withLock {
          $0.document = input.userMessage
          $0.eventID = input.clientEventId
        }
        return ChatHTTPResponse(status: 201, body: "{\"threadId\":\"\(Self.threadID)\"}")
      case "/api/chat-threads/\(Self.threadID)":
        return ChatHTTPResponse(body: #"{"cancellationRecoveryPending":false}"#)
      default: throw URLError(.unsupportedURL)
      }
    }
  }

  @MainActor func conversation() -> ConversationStore {
    let sync = ChatSync(client: http.client)
    return ConversationStore(
      thread: ChatThread(
        id: Self.threadID, agentID: Self.agentID, title: "Quoted follow-up",
        createdAt: .now, updatedAt: .now, sortAt: .now),
      sync: sync, commands: ChatCommands(client: http.client, sync: sync), webURL: http.baseURL,
      messageMarkdown: MessageMarkdownCache(baseURL: http.baseURL), isVisible: { false },
      didMarkRead: { _ in }, didSend: {}, didFail: { _ in }, didSettle: {})
  }
}
