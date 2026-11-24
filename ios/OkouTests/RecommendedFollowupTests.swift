import CCStateSwiftUI
import SwiftUI
import XCTest

@testable import Okou

@MainActor
final class RecommendedFollowupTests: XCTestCase {
  func testRecommendedTextAppendsSelectsAndKeepsNativeFocusAndUndoWithoutSending() async throws {
    let fixture = ConversationHistoryFixture(count: 1)
    let conversation = fixture.conversation()
    defer { conversation.close() }
    let host = UIHostingController(rootView: MentionComposerHarness(state: conversation.composer))
    let window = try await mountMentionHost(host)
    defer { unmount(window) }
    let input = try XCTUnwrap(mentionInputs(in: host.view).first)
    let editor = conversation.composer.editor
    let first = "Create a presentation outline"
    let second = "Compare the alternatives"
    try await focusMentionInput(input)
    input.insertText("Keep the context 🧭")
    editor.selectOrAppendText(first)
    try await waitForBusinessResult(watching: conversation.composer) {
      conversation.draft == "Keep the context 🧭\n" + first
    }
    try await eventually { input.isFirstResponder }
    XCTAssertEqual(input.selectedRange.length, 0)
    editor.selectOrAppendText(first)
    XCTAssertEqual((input.text as NSString).substring(with: input.selectedRange), first)
    XCTAssertEqual(conversation.draft, "Keep the context 🧭\n" + first)

    editor.selectOrAppendText(second)
    try await waitForBusinessResult(watching: conversation.composer) {
      conversation.draft.hasSuffix(first + "\n" + second)
    }
    replaceInput("Before " + second + " after " + second, in: input)
    editor.selectOrAppendText(second)
    XCTAssertEqual(input.selectedRange, NSRange(location: 7, length: second.utf16.count))
    XCTAssertTrue(input.isFirstResponder)
    input.undoManager?.removeAllActions()
    let beforeLongPrompt = conversation.draft
    let longPrompt =
      "What risks should we discuss next? " + String(repeating: "More context. ", count: 20)
    editor.selectOrAppendText(longPrompt)
    try await waitForBusinessResult(watching: conversation.composer) {
      conversation.draft.hasSuffix(longPrompt.trimmingCharacters(in: .whitespacesAndNewlines))
    }
    input.undoManager?.undo()
    try await waitForBusinessResult(watching: conversation.composer) {
      conversation.draft == beforeLongPrompt
    }
    replaceInput("", in: input)
    editor.selectOrAppendText(first)
    try await waitForBusinessResult(watching: conversation.composer) { conversation.draft == first }
    replaceInput("Keep the trailing paragraph\n   ", in: input)
    editor.selectOrAppendText(first)
    try await waitForBusinessResult(watching: conversation.composer) {
      conversation.draft == "Keep the trailing paragraph\n   " + first
    }
    XCTAssertFalse(
      fixture.requests.values.withLock {
        $0.contains { $0.contains("/api/chat/events") || $0.contains("generat") }
      })
  }

  func testPlaceholderAcceptanceEditsOnlyAnEmptyUnmarkedDraft() async throws {
    let fixture = ConversationHistoryFixture(count: 1)
    let conversation = fixture.conversation()
    defer { conversation.close() }
    let state = conversation.composer
    let prompt = "Compare the alternatives"
    let host = UIHostingController(
      rootView: StoreProvider(state.store) {
        FollowupComposerHarness(state: state, followup: prompt)
      })
    let window = try await mountMentionHost(host)
    defer { unmount(window) }
    let input = try XCTUnwrap(mentionInputs(in: host.view).first)
    XCTAssertTrue(conversation.draft.isEmpty)
    state.editor.acceptFollowup("A different thread's suggestion")
    XCTAssertTrue(conversation.draft.isEmpty)
    state.editor.acceptFollowup(prompt)
    XCTAssertEqual(conversation.draft, prompt)
    XCTAssertTrue(input.isFirstResponder)
    input.insertText(" ")
    input.insertText("please")
    input.insertText("\n")
    input.insertText("Second line")
    XCTAssertEqual(conversation.draft, prompt + " please\nSecond line")

    replaceInput("", in: input)
    input.insertText(" ")
    XCTAssertEqual(conversation.draft, prompt)
    replaceInput("", in: input)
    input.setMarkedText("ni", selectedRange: NSRange(location: 2, length: 0))
    _ = try XCTUnwrap(input.markedTextRange)
    state.editor.acceptFollowup(prompt)
    XCTAssertNotNil(input.markedTextRange)
    input.insertText(" ")
    XCTAssertFalse(conversation.draft.contains(prompt))
    XCTAssertTrue(conversation.pending.isEmpty)
  }

  private func replaceInput(_ text: String, in input: ComposerTextView) {
    input.selectedRange = NSRange(location: 0, length: input.text.utf16.count)
    if text.isEmpty { input.deleteBackward() } else { input.insertText(text) }
  }
}

/// Hosts the feedback composer the way `ChatComposerView` does: the draft's presentation comes
/// from the session Store.
private struct FollowupComposerHarness: View {
  let state: ComposerDraftStore
  let followup: String
  @ResolvedValue private var presentation: ComposerDraftPresentation?

  init(state: ComposerDraftStore, followup: String) {
    self.state = state
    self.followup = followup
    _presentation = ResolvedValue(state.presentation)
  }

  var body: some View {
    ChatFeedbackComposer(
      state: state, presentation: presentation ?? state.currentPresentation,
      inputID: state.attachments.inputID, isFocused: .constant(false),
      acceptsImages: true, followup: followup)
  }
}
