import ChatDomain
import SwiftUI
import XCTest

@testable import Okou

@MainActor
final class ChatComposerSubmissionTests: XCTestCase {
  func testSendingTextDismissesKeyboardAndLeavesACompactComposerAfterFailureAndRetry() async throws
  {
    let fixture = AttachmentFlowFixture(failSend: true)
    let conversation = fixture.conversation()
    defer { conversation.close() }
    let host = UIHostingController(rootView: composer(conversation))
    let window = try await mount(host)
    defer { unmount(window) }
    let original = try XCTUnwrap(inputs(in: host.view).first)
    original.becomeFirstResponder()
    original.insertText("Send this message")
    try await eventually {
      original.isFirstResponder && original.bounds.height > (original.font?.lineHeight ?? 20)
    }

    await conversation.send()
    let pending = try XCTUnwrap(conversation.pending.first)
    XCTAssertTrue(pending.needsRetry)
    try await assertCompactAndUnfocused(in: host.view, replacing: original)

    let next = try XCTUnwrap(inputs(in: host.view).first)
    next.becomeFirstResponder()
    next.insertText("Keep typing the next draft")
    try await eventually { next.isFirstResponder }
    await conversation.retry(pending)
    XCTAssertEqual(fixture.state.value.withLock { $0.messages.count }, 2)
    XCTAssertTrue(next.isFirstResponder)
    XCTAssertEqual(next.text, "Keep typing the next draft")
    XCTAssertEqual(conversation.draft, "Keep typing the next draft")
  }

  func testSendingAQuotedNoteDismissesItsKeyboardBeforeReturningToThePlainComposer() async throws {
    let fixture = AttachmentFlowFixture()
    let conversation = fixture.conversation()
    defer { conversation.close() }
    let host = UIHostingController(rootView: composer(conversation))
    let window = try await mount(host)
    defer { unmount(window) }
    let message = ChatMessage(
      id: "assistant-event", role: .assistant, text: "A passage to discuss", createdAt: .now,
      isQueued: false, isError: false)
    let selection = try XCTUnwrap(
      ChatFeedbackSelection(
        message: message, range: NSRange(location: 0, length: message.text.utf16.count)))
    conversation.composer.addFeedback(selection)
    try await eventually {
      self.inputs(in: host.view).contains {
        $0.accessibilityLabel == "Ask or comment on this quote" && $0.isFirstResponder
      }
    }
    let note = try XCTUnwrap(inputs(in: host.view).first(where: \.isFirstResponder))
    note.insertText("Please explain")

    await conversation.send()
    XCTAssertEqual(fixture.state.value.withLock { $0.messages.count }, 1)
    try await assertCompactAndUnfocused(in: host.view, replacing: note)
    XCTAssertFalse(conversation.composer.hasContent)
  }

  private func assertCompactAndUnfocused(in view: UIView, replacing original: ComposerTextView)
    async throws
  {
    try await eventually(
      message: "The replacement composer should stay compact with the keyboard dismissed"
    ) {
      let inputs = self.inputs(in: view)
      guard inputs.count == 1, let input = inputs.first else { return false }
      return input !== original && input.text.isEmpty && !input.isFirstResponder
        && input.bounds.height < (input.font?.lineHeight ?? 20) * 2
    }
  }

  private func composer(_ conversation: ConversationStore) -> some View {
    ChatComposerView(
      draft: Binding(get: { conversation.draft }, set: { conversation.draft = $0 }),
      isBusy: conversation.isSending, showsProgress: false, canStop: false, needsUpgrade: false,
      error: conversation.error, attachmentURL: conversation.webURL,
      attachments: conversation.attachmentDraft, draftState: conversation.composer,
      submit: { await conversation.send() }, refresh: nil)
  }

  private func mount<V: View>(_ host: UIHostingController<V>) async throws -> UIWindow {
    let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
    let window = UIWindow(windowScene: scene)
    window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
    window.rootViewController = host
    window.makeKeyAndVisible()
    try await eventually { self.inputs(in: host.view).first?.bounds.isEmpty == false }
    return window
  }

  private func inputs(in view: UIView) -> [ComposerTextView] {
    if let input = view as? ComposerTextView { return [input] }
    return view.subviews.flatMap { inputs(in: $0) }
  }
}
