import ChatData
import ChatDomain
import SwiftUI
import XCTest

@testable import Okou

@MainActor
final class ChatComposerReturnKeyTests: XCTestCase {
  func testRepeatedKeyboardSendDoesNotStopTheExistingWorkAfterTheDraftClears() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let preferences = ComposerPreferences(storage: ComposerPreferencesStorage(directory: directory))
    preferences.setReturnKey(.send)
    let fixture = ConversationHistoryFixture(count: 1)
    let conversation = fixture.conversation()
    defer { conversation.close() }
    await conversation.refresh()
    XCTAssertEqual(conversation.history?.canStop, true)
    let host = UIHostingController(
      rootView: ChatDetailView(conversation: conversation)
        .environment(\.composerPreferences, preferences))
    let window = try await mountMentionHost(host)
    defer { unmount(window) }
    let input = try XCTUnwrap(mentionInputs(in: host.view).first)
    try await focusMentionInput(input)
    input.insertText("Keep the existing work running")

    // Both key events arrive before the scheduled submission can clear the editor.
    input.insertText("\n")
    input.insertText("\n")
    try await waitForBusinessResult {
      !conversation.isSending && conversation.pending.contains { $0.needsRetry }
    }
    let writes = try fixture.requests.sentMessages.withLock {
      try $0.map { try JSONDecoder().decode([String: JSONValue].self, from: $0) }
    }
    XCTAssertEqual(writes.map { $0["prompt"]?.string }, ["Keep the existing work running"])
    XCTAssertEqual(conversation.history?.canStop, true)
    XCTAssertNil(conversation.stopIssue)
  }

  func testDefaultReturnEditsTheDraftAndSavedSendPreferenceDeliversTheSameMessage() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let preferences = ComposerPreferences(storage: ComposerPreferencesStorage(directory: directory))
    let fixture = AttachmentFlowFixture()
    let conversation = fixture.conversation()
    defer { conversation.close() }
    let source = ComposerMentionSource(agentID: AttachmentFlowFixture.agentID, threads: [])
    let host = UIHostingController(
      rootView: MentionComposerHarness(conversation: conversation, source: source)
        .environment(\.composerPreferences, preferences))
    let window = try await mountMentionHost(host)
    defer { unmount(window) }
    let input = try XCTUnwrap(mentionInputs(in: host.view).first)
    try await focusMentionInput(input)
    input.insertText("First")
    input.insertText("\n")
    input.insertText("Second")
    XCTAssertEqual(conversation.draft, "First\nSecond")
    XCTAssertTrue(fixture.state.value.withLock { $0.messages.isEmpty })

    preferences.setReturnKey(.send)
    try await eventually { input.returnKeyType == .send }
    input.insertText("\n")
    try await waitForBusinessResult {
      conversation.pending.isEmpty && conversation.draft.isEmpty
        && conversation.messages.contains { $0.text.contains("First\nSecond") }
    }
    let sent = try fixture.state.value.withLock {
      try $0.messages.map { try JSONDecoder().decode(AttachmentFlowFixture.Message.self, from: $0) }
    }
    XCTAssertEqual(sent.map { $0.userMessage.parts.compactMap(\.text).joined() }, ["First\nSecond"])
  }

  func testSendModeKeepsIMEConfirmationWithNativeEditingBeforeAnExplicitSend() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let preferences = ComposerPreferences(storage: ComposerPreferencesStorage(directory: directory))
    preferences.setReturnKey(.send)
    let fixture = AttachmentFlowFixture()
    let conversation = fixture.conversation()
    defer { conversation.close() }
    let source = ComposerMentionSource(agentID: AttachmentFlowFixture.agentID, threads: [])
    let host = UIHostingController(
      rootView: MentionComposerHarness(conversation: conversation, source: source)
        .environment(\.composerPreferences, preferences))
    let window = try await mountMentionHost(host)
    defer { unmount(window) }
    let input = try XCTUnwrap(mentionInputs(in: host.view).first)
    try await focusMentionInput(input)
    input.setMarkedText("确认发布", selectedRange: NSRange(location: 4, length: 0))
    input.unmarkText()
    input.insertText("\n")
    XCTAssertTrue(conversation.draft.contains("确认发布"))
    XCTAssertTrue(fixture.state.value.withLock { $0.messages.isEmpty })
    try await eventually { !input.isSettlingComposition }
    input.insertText("\n")
    try await waitForBusinessResult {
      conversation.pending.isEmpty && conversation.draft.isEmpty
        && conversation.messages.contains { $0.text.contains("确认发布") }
    }
    let sent = try fixture.state.value.withLock {
      try $0.messages.map { try JSONDecoder().decode(AttachmentFlowFixture.Message.self, from: $0) }
    }
    XCTAssertTrue(
      sent.first?.userMessage.parts.compactMap(\.text).joined().contains("确认发布") == true)
  }

  func testSendModeSelectsAChatReferenceAndMenuNewlinePreservesItsPartsAndUndo() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let preferences = ComposerPreferences(storage: ComposerPreferencesStorage(directory: directory))
    preferences.setReturnKey(.send)
    let fixture = MentionNavigationFixture()
    let workspace = try await fixture.workspace()
    defer { workspace.close() }
    let host = UIHostingController(
      rootView: MentionComposerHarness(workspace: workspace)
        .environment(\.composerPreferences, preferences))
    let window = try await mountMentionHost(host)
    defer { unmount(window) }
    let input = try XCTUnwrap(mentionInputs(in: host.view).first)
    try await focusMentionInput(input)
    input.insertText("Before @pl")
    try await eventually { mentionTable(in: host.view)?.visibleCells.first != nil }
    input.insertText("\n")
    try await waitForBusinessResult {
      workspace.newComposer.document.parts.contains { $0["type"]?.string == "chat_thread" }
    }
    input.insertText("🌷 old after")
    let before = workspace.newComposer.document
    input.selectedRange = (input.text as NSString).range(of: "old")
    try await eventually { input.undoManager?.groupingLevel == 0 }
    input.insertNewline()
    XCTAssertEqual(workspace.newChatDraft, "Before  🌷 \n after")
    XCTAssertEqual(
      workspace.newComposer.document.parts.filter { $0["type"]?.string != "text" },
      before.parts.filter { $0["type"]?.string != "text" })
    XCTAssertTrue(input.isFirstResponder)
    try await eventually { input.undoManager?.groupingLevel == 0 }
    input.undoManager?.undo()
    try await waitForBusinessResult { workspace.newComposer.document == before }
  }
}
