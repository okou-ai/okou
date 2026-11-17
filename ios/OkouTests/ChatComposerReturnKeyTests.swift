import ChatData
import ChatDomain
import SwiftUI
import XCTest

@testable import Okou

@MainActor
final class ChatComposerReturnKeyTests: XCTestCase {
  func testRecommendedFollowupSendsFromAnInitiallyUnfocusedEmptyComposer() async throws {
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
    let prompt = "帮我提一个 issue 记录这个侧栏开关 bug"

    conversation.composer.editor.selectOrAppendText(prompt)
    try await waitForBusinessResult { conversation.draft == prompt && input.isFirstResponder }
    // Selecting the same follow-up must keep one prompt and must not submit it.
    conversation.composer.editor.selectOrAppendText(prompt)
    XCTAssertEqual(conversation.draft, prompt)
    XCTAssertTrue(fixture.state.value.withLock { $0.messages.isEmpty })
    input.insertText("\n")
    try await waitForBusinessResult(
      message: recommendedFollowupSendStatus(
        conversation, fixture: fixture, input: input, prompt: prompt)
    ) {
      conversation.pending.isEmpty && conversation.draft.isEmpty
        && conversation.messages.contains { $0.text == prompt }
    }
    let sent = try fixture.state.value.withLock {
      try $0.messages.map { try JSONDecoder().decode(AttachmentFlowFixture.Message.self, from: $0) }
    }
    XCTAssertEqual(sent.map { $0.userMessage.parts.compactMap(\.text).joined() }, [prompt])
  }

  private func recommendedFollowupSendStatus(
    _ conversation: ConversationStore, fixture: AttachmentFlowFixture,
    input: ComposerTextView, prompt: String
  ) -> String {
    let pending = conversation.pending.map { "\($0.id):retry=\($0.needsRetry)" }
    let messages = conversation.messages.map { "\($0.id):matchesPrompt=\($0.text == prompt)" }
    let persisted = conversation.history?.persistedEventIDs.sorted() ?? []
    let delivery = fixture.state.value.withLock {
      (writes: $0.messages.count, accepted: $0.accepted != nil)
    }
    return "Recommended followup send after waiter join: "
      + "sending=\(conversation.isSending); loading=\(conversation.isLoading); "
      + "pending=\(pending); draft=\(String(reflecting: conversation.draft)); "
      + "messages=\(messages); persisted=\(persisted); "
      + "writes=\(delivery.writes); accepted=\(delivery.accepted); "
      + "error=\(String(describing: conversation.error)); "
      + "syncError=\(String(describing: conversation.syncError)); "
      + "returnKey=\(input.returnKeyPreference); editable=\(input.isEditable); submitted input: "
      + mentionInputStatus(input)
  }

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
    try await waitForBusinessResult(
      message: repeatedSendStatus(conversation, fixture: fixture, input: input)
    ) {
      !conversation.isSending && !conversation.isStopping
        && conversation.pending.contains { $0.needsRetry }
    }
    let writes = try fixture.requests.sentMessages.withLock {
      try $0.map { try JSONDecoder().decode([String: MessageJSON].self, from: $0) }
    }
    XCTAssertEqual(writes.map { $0["prompt"]?.string }, ["Keep the existing work running"])
    XCTAssertEqual(conversation.history?.canStop, true)
    XCTAssertNil(conversation.stopIssue)
  }

  private func repeatedSendStatus(
    _ conversation: ConversationStore, fixture: ConversationHistoryFixture, input: ComposerTextView
  ) -> String {
    let pending = conversation.pending.map { "\($0.id):retry=\($0.needsRetry)" }
    let requests = fixture.requests.values.withLock { $0 }
    let writes = fixture.requests.sentMessages.withLock { $0.count }
    return "Repeated keyboard send after waiter join: "
      + "sending=\(conversation.isSending); stopping=\(conversation.isStopping); "
      + "pending=\(pending); writes=\(writes); requests=\(requests); "
      + "draft=\(String(reflecting: conversation.draft)); "
      + "error=\(String(describing: conversation.error)); "
      + "canStop=\(String(describing: conversation.history?.canStop)); "
      + "stopIssue=\(String(describing: conversation.stopIssue)); submitted input: "
      + mentionInputStatus(input)
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

  private func chatReferenceSuggestionStatus(
    _ workspace: WorkspaceStore, fixture: MentionNavigationFixture,
    input: ComposerTextView, host: UIView
  ) -> String {
    let paths = fixture.paths.value.withLock { $0 }
    return "Chat reference suggestions after native readiness wait: "
      + "agent=\(String(describing: workspace.selectedAgentID)); "
      + "threads=\(workspace.list.threads.count); "
      + "threadsLoaded=\(workspace.list.hasLoadedThreads); "
      + "workspaceError=\(String(describing: workspace.error)); "
      + "listActionOrSyncError=\(String(describing: workspace.list.error)); "
      + "draft=\(String(reflecting: workspace.newChatDraft)); "
      + "ownsEditor=\(input.mentionEditor === workspace.newComposer.editor); "
      + "requests=\(paths); " + mentionState(input, in: host)
  }
}
