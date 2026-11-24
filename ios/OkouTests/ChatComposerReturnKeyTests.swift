import ChatDomain
import SwiftUI
import XCTest

@testable import Okou

@MainActor
final class ChatComposerReturnKeyTests: XCTestCase {
  func testReturnEditsTheMultilineDraftUntilItIsExplicitlySent() async throws {
    let fixture = AttachmentFlowFixture()
    let conversation = fixture.conversation()
    defer { conversation.close() }
    let source = ComposerMentionSource(threads: [])
    let host = UIHostingController(
      rootView: MentionComposerHarness(conversation: conversation, source: source))
    let window = try await mountMentionHost(host)
    defer { unmount(window) }
    let input = try XCTUnwrap(mentionInputs(in: host.view).first)
    try await focusMentionInput(input)
    input.insertText("First")
    input.insertText("\n")
    input.insertText("Second")
    XCTAssertEqual(conversation.draft, "First\nSecond")
    XCTAssertTrue(fixture.state.value.withLock { $0.messages.isEmpty })

    await conversation.send()
    let sent = try fixture.state.value.withLock {
      try $0.messages.map { try JSONDecoder().decode(AttachmentFlowFixture.Message.self, from: $0) }
    }
    XCTAssertEqual(sent.map { $0.userMessage.parts.compactMap(\.text).joined() }, ["First\nSecond"])
  }

  func testReturnSelectsAChatReferenceAndNewlinesPreserveItsPartsAndUndo() async throws {
    let fixture = MentionNavigationFixture()
    let workspace = try await fixture.workspace()
    defer { workspace.close() }
    let host = UIHostingController(rootView: MentionComposerHarness(workspace: workspace))
    let window = try await mountMentionHost(host)
    defer { unmount(window) }
    let input = try XCTUnwrap(mentionInputs(in: host.view).first)
    try await focusMentionInput(input)
    input.insertText("Before @pl")
    try await eventually(
      message: chatReferenceSuggestionStatus(
        workspace, fixture: fixture, input: input, host: host.view)
    ) {
      mentionTable(in: host.view)?.visibleCells.first != nil
    }
    input.insertText("\n")
    try await waitForBusinessResult {
      workspace.newComposer.document.parts.contains { $0["type"]?.string == "chat_thread" }
    }
    input.insertText("🌷 old after")
    let before = workspace.newComposer.document
    input.selectedRange = (input.text as NSString).range(of: "old")
    try await eventually { input.undoManager?.groupingLevel == 0 }
    input.insertText("\n")
    XCTAssertEqual(workspace.newChatDraft, "Before  🌷 \n after")
    XCTAssertEqual(
      workspace.newComposer.document.parts.filter { $0["type"]?.string != "text" },
      before.parts.filter { $0["type"]?.string != "text" })
    XCTAssertTrue(input.isFirstResponder)
    try await eventually { input.undoManager?.groupingLevel == 0 }
    input.undoManager?.undo()
    try await waitForBusinessResult { workspace.newComposer.document == before }
  }

  private func chatReferenceSuggestionStatus(
    _ workspace: WorkspaceStore, fixture: MentionNavigationFixture,
    input: ComposerTextView, host: UIView
  ) -> String {
    let paths = fixture.paths.value.withLock { $0 }
    return "Chat reference suggestions after native readiness wait: "
      + "threads=\(workspace.list.threads.count); "
      + "threadsLoaded=\(workspace.list.hasLoadedThreads); "
      + "workspaceError=\(String(describing: workspace.error)); "
      + "listActionOrSyncError=\(String(describing: workspace.list.error)); "
      + "draft=\(String(reflecting: workspace.newChatDraft)); "
      + "ownsEditor=\(input.mentionEditor === workspace.newComposer.editor); "
      + "requests=\(paths); " + mentionState(input, in: host)
  }
}
