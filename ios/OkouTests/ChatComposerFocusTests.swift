import SwiftUI
import XCTest

@testable import Okou

@MainActor
final class ChatComposerFocusTests: XCTestCase {
  func testCancelledNavigationRestoresDraftSelectionWithoutFocusingTheHiddenPage() async throws {
    let fixture = AttachmentFlowFixture()
    let conversation = fixture.conversation()
    defer { conversation.close() }
    conversation.draft = "Before 🌷 after"
    let presentation = WorkspaceChatPresentation()
    let host = UIHostingController(
      rootView: MentionComposerHarness(state: conversation.composer)
        .environment(\.workspaceChatPresentation, presentation))
    let window = try await mountMentionHost(host)
    defer { unmount(window) }
    let input = try XCTUnwrap(mentionInputs(in: host.view).first)

    // Attachment alone must not let the retained page steal the keyboard.
    input.prepareFocus(true)
    XCTAssertFalse(input.isFirstResponder)
    presentation.appear()
    try await eventually { input.isFirstResponder }
    input.selectedRange = NSRange(location: 7, length: 2)

    presentation.beginTransition(showsChat: false)
    input.resignFirstResponder()
    presentation.finishTransition(showsChat: true)
    try await eventually { input.isFirstResponder }
    input.insertText("continued")
    XCTAssertEqual(conversation.draft, "Before continued after")
  }

  func testCompactActivationAppendsAtEndAndExpandedEditingKeepsNativeSelection() async throws {
    let fixture = AttachmentFlowFixture()
    let conversation = fixture.conversation()
    defer { conversation.close() }
    let draft = "第一行 🌷\n那 43481 可以先合并。"
    conversation.draft = draft
    let host = UIHostingController(rootView: MentionComposerHarness(state: conversation.composer))
    let window = try await mountMentionHost(host)
    defer { unmount(window) }
    let input = try XCTUnwrap(mentionInputs(in: host.view).first)
    let expand = try XCTUnwrap(
      nativeViews(in: host.view).compactMap { $0 as? UIButton }.first {
        $0.accessibilityIdentifier == "expand-message-input"
      })

    input.selectedRange = NSRange(location: 2, length: 0)
    expand.sendActions(for: .touchUpInside)
    try await eventually { input.isFirstResponder }
    input.insertText("继续")
    XCTAssertEqual(conversation.draft, draft + "继续")

    try await eventually { input.text == draft + "继续" }
    input.selectedRange = NSRange(location: 0, length: 3)
    input.insertText("修改")
    let edited = "修改 🌷\n那 43481 可以先合并。继续"
    XCTAssertEqual(conversation.draft, edited)

    input.selectedRange = NSRange(location: 2, length: 0)
    input.resignFirstResponder()
    try await eventually { !expand.isHidden }
    expand.sendActions(for: .touchUpInside)
    try await eventually { input.isFirstResponder }
    input.insertText("再继续")
    XCTAssertEqual(conversation.draft, edited + "再继续")
  }
}
