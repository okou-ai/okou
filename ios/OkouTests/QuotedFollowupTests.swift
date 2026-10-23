import ChatData
import ChatDataTestSupport
import ChatDomain
import SwiftUI
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class QuotedFollowupTests: XCTestCase {
  func testNativeQuoteActionFocusesANoteWithUndoAndMarkedText() async throws {
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
    try await eventually { note.text == "Explain this." }
    note.undoManager?.undo()
    try await eventually { note.text.isEmpty }
    note.setMarkedText("拼音", selectedRange: NSRange(location: 2, length: 0))
    try await eventually { note.markedTextRange != nil }
    note.unmarkText()
    try await eventually { note.text == "拼音" }
    XCTAssertTrue(note.isFirstResponder)
    let ordinary = try XCTUnwrap(
      textViews(in: host.view).first {
        $0.accessibilityIdentifier == "message-input" && $0.text == "Keep the ordinary draft."
      })
    XCTAssertEqual(ordinary.text, "Keep the ordinary draft.")
    XCTAssertNil(host.presentedViewController)
  }

  func testQuotedOnlyRetryKeepsItsCanonicalSourceAndTheNextDraft() async throws {
    let fixture = AttachmentFlowFixture(failSend: true)
    let conversation = fixture.conversation()
    defer { conversation.close() }
    let message = output("Prefix 🌷 selected passage")
    let selection = try XCTUnwrap(
      ChatFeedbackSelection(
        message: message, range: (message.text as NSString).range(of: "selected passage")))
    conversation.composer.addFeedback(selection)
    await conversation.send()
    let pending = try XCTUnwrap(conversation.pending.first)
    conversation.draft = "New work while retrying"
    await conversation.retry(pending)
    let writes = fixture.state.value.withLock { $0.messages }
    XCTAssertEqual(writes.count, 2)
    let first = try JSONDecoder().decode(QuotedSend.self, from: XCTUnwrap(writes.first))
    let retried = try JSONDecoder().decode(QuotedSend.self, from: XCTUnwrap(writes.last))
    XCTAssertTrue(first.hasTextContent)
    XCTAssertEqual(first.clientEventId, retried.clientEventId)
    XCTAssertEqual(first.userMessage, ChatDraftDocument(parts: [selection.part]))
    XCTAssertEqual(retried.userMessage, first.userMessage)
    XCTAssertEqual(conversation.draft, "New work while retrying")
  }

  func testQuoteCommandRejectsForeignStaleAndClosedSourcesBeforeSending() async throws {
    let text = "Café status. Review the final evidence."
    let payload = String(decoding: try JSONEncoder().encode(["content": text]), as: UTF8.self)
    let fixture = ConversationHistoryFixture(rows: [
      """
      {"id":"\(ConversationHistoryFixture.id(1))","chatThreadId":"\(ConversationHistoryFixture.threadID)","seqId":1,"eventType":"output.message","createdAt":"2026-10-20T10:00:00Z","payload":\(payload)}
      """
    ])
    let conversation = fixture.conversation()
    defer { conversation.close() }
    await conversation.refresh()
    let message = try XCTUnwrap(conversation.messages.first)
    let selection = try XCTUnwrap(
      ChatFeedbackSelection(
        message: message, range: (message.text as NSString).range(of: "Review the final evidence")))

    let unrelatedFixture = AttachmentFlowFixture()
    let unrelated = unrelatedFixture.conversation()
    defer { unrelated.close() }
    unrelated.quote(selection)
    XCTAssertFalse(unrelated.composer.hasContent)

    // Canonically equal text can have different UTF-16 offsets in a stale selection.
    let stale = ChatMessage(
      id: message.id, role: .assistant,
      text: text.replacingOccurrences(of: "Café", with: "Cafe\u{0301}"),
      createdAt: message.createdAt, isQueued: false, isError: false)
    XCTAssertEqual(stale.text, message.text)
    XCTAssertNotEqual(stale.text.utf16.count, message.text.utf16.count)
    conversation.quote(
      try XCTUnwrap(
        ChatFeedbackSelection(
          message: stale, range: (stale.text as NSString).range(of: "Review the final evidence"))))
    XCTAssertFalse(conversation.composer.hasContent)

    conversation.quote(selection)
    await conversation.send()
    let data = try XCTUnwrap(fixture.requests.sentMessages.withLock { $0.first })
    let sent = try JSONDecoder().decode(QuotedSend.self, from: data)
    XCTAssertEqual(sent.userMessage, ChatDraftDocument(parts: [selection.part]))
    XCTAssertFalse(conversation.composer.hasContent)
    conversation.close()
    conversation.quote(selection)
    XCTAssertFalse(conversation.composer.hasContent)
  }

  private struct QuotedSend: Decodable {
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
    let window = try await mountNativeHost(host) { _ in !self.textViews(in: host.view).isEmpty }
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
