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
    let text = "👋 **First paragraph.**\n\nSelected 🌷 é passage.\n\nLast paragraph."
    let payload = String(decoding: try JSONEncoder().encode(["content": text]), as: UTF8.self)
    let fixture = ConversationHistoryFixture(rows: [
      """
      {"id":"\(ConversationHistoryFixture.id(1))","chatThreadId":"\(ConversationHistoryFixture.threadID)","seqId":1,"eventType":"output.message","createdAt":"2026-10-20T10:00:00Z","payload":\(payload)}
      """
    ])
    let conversation = fixture.conversation()
    defer { conversation.close() }
    conversation.draft = "Keep the ordinary draft."
    await conversation.refresh()
    let host = UIHostingController(rootView: ChatDetailView(conversation: conversation))
    let window = try await mountNativeHost(host) { _ in self.passageInput(in: host.view) != nil }
    defer { unmount(window) }
    let selection = try XCTUnwrap(passageInput(in: host.view))
    selection.becomeFirstResponder()
    let document = try XCTUnwrap(
      selection.textRange(from: selection.beginningOfDocument, to: selection.endOfDocument))
    let visible = try XCTUnwrap(selection.text(in: document))
    let range = (visible as NSString).range(of: "Selected 🌷 é passage.")
    let start = try XCTUnwrap(
      selection.position(from: selection.beginningOfDocument, offset: range.location))
    let end = try XCTUnwrap(selection.position(from: start, offset: range.length))
    selection.selectedTextRange = selection.textRange(from: start, to: end)
    await hostingPresentationFrame()
    let cell = try XCTUnwrap(enclosingCell(selection) as? MessageSelectionCell)
    let quote = try XCTUnwrap(cell.quoteAction())
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
    await conversation.send()
    let data = try XCTUnwrap(fixture.requests.sentMessages.withLock { $0.first })
    let sent = try JSONDecoder().decode(QuotedSend.self, from: data)
    let read = try JSONDecoder().decode(
      ChatUserMessage.self, from: JSONEncoder().encode(sent.userMessage))
    let feedback = try XCTUnwrap(read.parts.first { $0.type == "feedback" })
    XCTAssertEqual(feedback.quote, "Selected 🌷 é passage.")
    XCTAssertEqual(feedback.eventId, ConversationHistoryFixture.id(1))
    XCTAssertEqual(feedback.note?.map(\.displayText).joined(), "拼音")
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
  private func passageInput(in view: UIView) -> (UIView & UITextInput)? {
    nativeViews(in: view).compactMap { $0 as? (UIView & UITextInput) }.first { input in
      guard let range = input.textRange(from: input.beginningOfDocument, to: input.endOfDocument)
      else { return false }
      return input.text(in: range)?.contains("Selected 🌷 é passage.") == true
    }
  }
  private func textViews(in view: UIView) -> [UITextView] {
    if let input = view as? UITextView { return [input] }
    return view.subviews.flatMap { textViews(in: $0) }
  }
}
