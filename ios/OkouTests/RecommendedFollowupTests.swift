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
    try await eventually {
      conversation.draft == "Keep the context 🧭\n" + first && input.isFirstResponder
    }
    XCTAssertEqual(input.selectedRange.length, 0)
    editor.selectOrAppendText(first)
    XCTAssertEqual((input.text as NSString).substring(with: input.selectedRange), first)
    XCTAssertEqual(conversation.draft, "Keep the context 🧭\n" + first)

    editor.selectOrAppendText(second)
    try await eventually { conversation.draft.hasSuffix(first + "\n" + second) }
    replaceInput("Before " + second + " after " + second, in: input)
    editor.selectOrAppendText(second)
    XCTAssertEqual(input.selectedRange, NSRange(location: 7, length: second.utf16.count))
    XCTAssertTrue(input.isFirstResponder)
    input.undoManager?.removeAllActions()
    let beforeLongPrompt = conversation.draft
    let longPrompt =
      "What risks should we discuss next? " + String(repeating: "More context. ", count: 20)
    editor.selectOrAppendText(longPrompt)
    try await eventually {
      conversation.draft.hasSuffix(longPrompt.trimmingCharacters(in: .whitespacesAndNewlines))
    }
    input.undoManager?.undo()
    try await eventually { conversation.draft == beforeLongPrompt }
    replaceInput("", in: input)
    editor.selectOrAppendText(first)
    try await eventually { conversation.draft == first }
    replaceInput("Keep the trailing paragraph\n   ", in: input)
    editor.selectOrAppendText(first)
    try await eventually { conversation.draft == "Keep the trailing paragraph\n   " + first }
    XCTAssertFalse(
      fixture.requests.values.withLock {
        $0.contains { $0.contains("/api/chat/events") || $0.contains("generat") }
      })
  }

  private func replaceInput(_ text: String, in input: ComposerTextView) {
    input.selectedRange = NSRange(location: 0, length: input.text.utf16.count)
    if text.isEmpty { input.deleteBackward() } else { input.insertText(text) }
  }
}
