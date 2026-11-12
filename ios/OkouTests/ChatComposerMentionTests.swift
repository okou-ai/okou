import ChatData
import ChatDataTestSupport
import ChatDomain
import SwiftUI
import XCTest

@testable import Okou

@MainActor
final class ChatComposerMentionTests: XCTestCase {
  func testCandidatesMatchWorkspaceScopeOrderingFilteringAndLimits() async throws {
    let navigation = MentionNavigationFixture()
    let workspace = try await navigation.workspace()
    defer { workspace.close() }
    let source = workspace.mentionTestSource
    let chats = source.suggestions(for: "")
    XCTAssertEqual(chats.count, 25)
    // Sidebar pinOrder puts the older pin first; mention ordering uses activity.
    XCTAssertEqual(chats.first?.referenceID, MentionNavigationFixture.thread(35))
    XCTAssertEqual(chats.dropFirst().first?.referenceID, MentionNavigationFixture.thread(34))
    let filtered = source.suggestions(for: "pLaN")
    XCTAssertEqual(
      filtered.map(\.referenceID),
      [MentionNavigationFixture.thread(31)])
    XCTAssertEqual(filtered.map(\.title), ["Cross Agent archived plan"])

    // The current chat is a valid reference, as on the PWA.
    XCTAssertEqual(
      source.suggestions(for: "Current").map(\.referenceID), [AttachmentFlowFixture.threadID])
    XCTAssertTrue(source.suggestions(for: "missing").isEmpty)
  }

  func testMultipleInlineReferencesPreserveCursorSurroundingTextAndNativeUndoCopyPaste()
    async throws
  {
    preserveNativePasteboard(for: self)
    let navigation = MentionNavigationFixture()
    let workspace = try await navigation.workspace()
    defer { workspace.close() }
    let host = UIHostingController(rootView: MentionComposerHarness(workspace: workspace))
    let window = try await mountMentionHost(host)
    defer { unmount(window) }
    let input = try XCTUnwrap(mentionInputs(in: host.view).first)
    try await focusMentionInput(input)
    input.insertText("Before @pl after 🌷")
    input.selectedRange = NSRange(location: 10, length: 0)
    try await eventually { mentionTable(in: host.view)?.visibleCells.first != nil }
    let first = try XCTUnwrap(mentionTable(in: host.view)?.visibleCells.first)
    XCTAssertTrue(first.accessibilityActivate())
    try await waitForBusinessResult {
      workspace.newComposer.document.parts.contains { $0["type"]?.string == "chat_thread" }
    }
    XCTAssertEqual(input.selectedRange, NSRange(location: 9, length: 0))
    XCTAssertEqual(input.text, "Before \u{fffc} after 🌷")
    XCTAssertTrue(input.isFirstResponder)
    input.insertText("and @project")
    try await eventually {
      mentionTable(in: host.view)?.visibleCells.first?.accessibilityLabel == "Chat: Project 30"
    }
    input.insertText("\n")
    try await waitForBusinessResult {
      workspace.newComposer.document.parts.filter { $0["type"]?.string == "chat_thread" }.count == 2
    }
    let expected = workspace.newComposer.document
    XCTAssertEqual(
      expected.parts.map { $0["type"]?.string },
      ["text", "chat_thread", "text", "chat_thread", "text"])
    XCTAssertEqual(expected.text, "Before  and  after 🌷")
    let expectedNativeText = "Before \u{fffc} and \u{fffc} after 🌷"
    XCTAssertEqual(input.text, expectedNativeText)
    try await eventually { input.undoManager?.groupingLevel == 0 }

    input.selectedRange = NSRange(location: 7, length: 1)
    input.deleteBackward()
    try await waitForBusinessResult {
      workspace.newComposer.document.parts.filter { $0["type"]?.string == "chat_thread" }.count == 1
    }
    try await eventually { input.undoManager?.groupingLevel == 0 }
    input.undoManager?.undo()
    try await waitForBusinessResult(
      message:
        "After deletion undo: \(workspace.newComposer.document); text: \(String(describing: input.text))"
    ) { workspace.newComposer.document == expected }
    input.undoManager?.redo()
    try await waitForBusinessResult {
      workspace.newComposer.document.parts.filter { $0["type"]?.string == "chat_thread" }.count == 1
    }
    input.undoManager?.undo()
    try await waitForBusinessResult { workspace.newComposer.document == expected }

    input.selectedRange = NSRange(location: 0, length: input.text.utf16.count)
    input.copy(nil)
    XCTAssertTrue(UIPasteboard.general.string?.contains("/chats/") == true)
    input.cut(nil)
    try await waitForBusinessResult { !workspace.newComposer.hasContent }
    // Keep native insertion separate from business observation in timeout diagnostics.
    let trace = NativePasteTrace()
    let pasteDelegate = try XCTUnwrap(
      input.pasteDelegate as? ChatComposerTextInput.Coordinator)
    let tracedDelegate = NativePasteDelegate(delegate: pasteDelegate, trace: trace)
    input.pasteDelegate = tracedDelegate
    // pasteDelegate is weak; retain the forwarding delegate through async paste.
    defer { input.pasteDelegate = tracedDelegate.delegate }
    let observer = NotificationCenter.default.addObserver(
      forName: UITextView.textDidChangeNotification, object: input, queue: .main
    ) { _ in
      MainActor.assumeIsolated {
        if trace.nativeChange == nil, input.text == expectedNativeText {
          trace.nativeChange = trace.started.duration(to: .now)
          trace.canonicalAtNativeChange = workspace.newComposer.document == expected
        }
      }
    }
    defer { NotificationCenter.default.removeObserver(observer) }
    input.paste(nil)
    trace.record("paste returned")
    trace.record("business wait started")
    try await waitForBusinessResult(
      message: "Paste stages=\(trace.stages); native change=\(String(describing: trace.nativeChange)); "
        + "canonical at native change=\(String(describing: trace.canonicalAtNativeChange)); "
        + "elapsed=\(trace.started.duration(to: .now)); "
        + "document=\(workspace.newComposer.document); "
        + "text=\(String(describing: input.text)); "
        + "current=\(input.isCurrent()); focus=\(input.isFirstResponder); "
        + "undo=\(input.undoManager?.groupingLevel ?? -1)"
    ) { workspace.newComposer.document == expected }
    input.undoManager?.undo()
    try await waitForBusinessResult { !workspace.newComposer.hasContent }
    input.undoManager?.redo()
    try await waitForBusinessResult { workspace.newComposer.document == expected }

    input.selectedRange = NSRange(location: 0, length: input.text.utf16.count)
    input.insertText("Replacement 中文")
    try await waitForBusinessResult {
      workspace.newComposer.document.parts.count == 1 && workspace.newChatDraft == "Replacement 中文"
    }
    input.undoManager?.undo()
    try await waitForBusinessResult { workspace.newComposer.document == expected }
  }

  func testNativeMarkedTextConfirmationDoesNotInsertAMentionAndKeyboardNavigatesChats()
    async throws
  {
    let navigation = MentionNavigationFixture()
    let workspace = try await navigation.workspace()
    defer { workspace.close() }
    let host = UIHostingController(rootView: MentionComposerHarness(workspace: workspace))
    let window = try await mountMentionHost(host)
    defer { unmount(window) }
    let input = try XCTUnwrap(mentionInputs(in: host.view).first)
    try await focusMentionInput(input)
    let editor = workspace.newComposer.editor
    input.insertText("@")
    try await waitForBusinessResult { !editor.mentionSuggestions.isEmpty }
    // An empty query has no implicit choice: Return still edits the draft.
    input.insertText("\n")
    try await waitForBusinessResult { workspace.newChatDraft == "@\n" }
    input.insertText("@")
    input.setMarkedText("研究", selectedRange: NSRange(location: 2, length: 0))
    try await eventually {
      input.markedTextRange != nil && input.keyCommands?.contains { $0.input == "\r" } != true
    }
    input.unmarkText()
    input.insertText("\n")
    try await waitForBusinessResult { workspace.newChatDraft.contains("研究\n") }
    XCTAssertTrue(workspace.newComposer.document.parts.allSatisfy { $0["type"]?.string == "text" })
    input.insertText("@")
    let target = try XCTUnwrap(
      workspace.mentionTestSource.suggestions(for: "").first {
        $0.referenceID == MentionNavigationFixture.thread(35)
      })
    try await waitForBusinessResult { editor.mentionSuggestions.contains(target) }
    try await mentionKey(UIKeyCommand.inputDownArrow, input: input)
    try await mentionKey(UIKeyCommand.inputDownArrow, input: input)
    try await mentionKey(UIKeyCommand.inputUpArrow, input: input)
    input.insertText("\n")
    try await waitForBusinessResult {
      workspace.newComposer.document.parts.contains(target.part)
    }
    XCTAssertTrue(input.isFirstResponder)
    XCTAssertTrue(navigation.paths.value.withLock { $0.allSatisfy { !$0.contains("/search") } })
    input.insertText("@")
    try await waitForBusinessResult { editor.mentionSuggestions.contains(target) }
    try await mentionKey(UIKeyCommand.inputEscape, input: input)
    XCTAssertFalse(editor.handleMentionKey("\r", in: input))
    XCTAssertTrue(input.isFirstResponder)
    input.insertText("missing")
    input.insertText("\n")
    XCTAssertTrue(workspace.newChatDraft.hasSuffix("missing\n"))
  }

  func testReferenceOnlySendAndUncertainRetryKeepCanonicalPartsAndCurrentAgent() async throws {
    let fixture = AttachmentFlowFixture(failSend: true)
    let conversation = fixture.conversation()
    let navigation = MentionNavigationFixture()
    let workspace = try await navigation.workspace()
    defer {
      conversation.close()
      workspace.close()
    }
    let reference: MessageJSON = .object([
      "type": .string("agent"), "agentId": .string(MentionNavigationFixture.agent(1)),
      "nameSnapshot": .string("Planner"),
    ])
    let draft = ChatDraftDocument(parts: [
      reference, .object(["type": .string("text"), "text": .string(" ")]),
    ])
    let expected = ChatDraftDocument(parts: [reference])
    let block = try XCTUnwrap(conversation.composer.editorBlocks.first)
    conversation.composer.editBlock(block.id, document: draft)
    XCTAssertEqual(conversation.composer.document, draft)
    XCTAssertTrue(conversation.composer.hasContent)
    XCTAssertEqual(conversation.draft.trimmingCharacters(in: .whitespacesAndNewlines), "")
    await conversation.send()
    let pending = try XCTUnwrap(conversation.pending.first)
    XCTAssertTrue(pending.needsRetry)
    XCTAssertEqual(pending.document, expected)
    conversation.draft = "Next draft"
    await conversation.retry(pending)
    let sends = try fixture.state.value.withLock { $0.messages }.map {
      try JSONDecoder().decode(MentionSend.self, from: $0)
    }
    XCTAssertEqual(sends.count, 2)
    XCTAssertTrue(sends.allSatisfy(\.hasTextContent))
    XCTAssertEqual(
      sends.map(\.agentId), [AttachmentFlowFixture.agentID, AttachmentFlowFixture.agentID])
    XCTAssertEqual(sends[0].clientEventId, sends[1].clientEventId)
    XCTAssertEqual(sends[1].userMessage, expected)
    XCTAssertEqual(conversation.draft, "Next draft")
    XCTAssertTrue(conversation.pending.isEmpty)
    let sent = try XCTUnwrap(conversation.messages.first { $0.role == .user })
    XCTAssertEqual(sent.userMessage?.parts.first?.agentId, MentionNavigationFixture.agent(1))
  }

  func testQuotedNotesMixReferencesAndAttachmentsWithoutChangingQuoteSource() async throws {
    let fixture = AttachmentFlowFixture()
    let conversation = fixture.conversation()
    let navigation = MentionNavigationFixture()
    let workspace = try await navigation.workspace()
    defer {
      conversation.close()
      workspace.close()
    }
    let message = ChatMessage(
      id: "quoted-event", role: .assistant, text: "A passage to compare", createdAt: .now,
      isQueued: false, isError: false)
    let quote = try XCTUnwrap(
      ChatFeedbackSelection(
        message: message, range: NSRange(location: 0, length: message.text.utf16.count)))
    let block = try XCTUnwrap(conversation.composer.addFeedback(quote))
    let source = workspace.mentionTestSource
    let chat = try XCTUnwrap(source.suggestions(for: "plan").first)
    let agent: MessageJSON = .object([
      "type": .string("agent"), "agentId": .string(MentionNavigationFixture.agent(1)),
      "nameSnapshot": .string("Planner"),
    ])
    let note = ChatDraftDocument(parts: [
      .object(["type": .string("text"), "text": .string("Compare ")]),
      chat.part,
      .object(["type": .string("text"), "text": .string(" with ")]),
      agent,
      .object(["type": .string("text"), "text": .string(" ")]),
    ])
    conversation.composer.editBlock(block, document: note)
    let file = FileManager.default.temporaryDirectory.appendingPathComponent(
      UUID().uuidString + ".txt")
    defer { try? FileManager.default.removeItem(at: file) }
    try Data("Reference comparison".utf8).write(to: file)
    conversation.attachmentDraft.importFiles([file])
    try await waitForBusinessResult {
      conversation.attachmentDraft.hasAttachments && conversation.attachmentDraft.isReady
    }
    let expected = conversation.composer.value.draftUserMessage
    XCTAssertEqual(expected?.parts.first?["eventId"]?.string, "quoted-event")
    XCTAssertEqual(expected?.parts.first?["quote"]?.string, quote.quote)
    guard case .array(let parts) = expected?.parts.first?["note"] else {
      return XCTFail("Missing note")
    }
    XCTAssertEqual(
      parts.map { $0["type"]?.string }, ["text", "chat_thread", "text", "agent", "text"])
    XCTAssertEqual(parts[1]["threadId"]?.string, MentionNavigationFixture.thread(31))
    XCTAssertEqual(parts[3]["agentId"]?.string, MentionNavigationFixture.agent(1))
    XCTAssertEqual(expected?.parts.last?["fileId"]?.string, AttachmentFlowFixture.fileID)
    await conversation.send()
    let send = try JSONDecoder().decode(
      MentionSend.self, from: XCTUnwrap(fixture.state.value.withLock { $0.messages.first }))
    XCTAssertEqual(send.userMessage, expected)
    XCTAssertTrue(send.hasTextContent)
  }

  func testFirstSendMovesAChatReferenceIntoTheCreatedConversationAndRetainsFailedDelivery()
    async throws
  {
    let fixture = AttachmentFlowFixture(failSend: true)
    let workspace = WorkspaceStore(client: fixture.http.client, webURL: fixture.http.baseURL)
    await workspace.refreshNavigation()
    let navigation = MentionNavigationFixture()
    let candidates = try await navigation.workspace()
    defer {
      workspace.close()
      candidates.close()
    }
    let reference = try XCTUnwrap(
      candidates.mentionTestSource.suggestions(for: "plan").first)
    let draft = ChatDraftDocument(parts: [
      reference.part, .object(["type": .string("text"), "text": .string(" ")]),
    ])
    let expected = ChatDraftDocument(parts: [reference.part])
    let block = try XCTUnwrap(workspace.newComposer.editorBlocks.first)
    workspace.newComposer.editBlock(block.id, document: draft)
    XCTAssertEqual(workspace.newComposer.document, draft)
    await workspace.sendNewChat()
    let conversation = try XCTUnwrap(workspace.selectedConversation)
    let pending = try XCTUnwrap(conversation.pending.first)
    XCTAssertEqual(pending.document, expected)
    XCTAssertTrue(pending.needsRetry)
    XCTAssertFalse(workspace.newComposer.hasContent)
    await conversation.retry(pending)
    let sends = try fixture.state.value.withLock { $0.messages }.map {
      try JSONDecoder().decode(MentionSend.self, from: $0)
    }
    XCTAssertEqual(sends.count, 2)
    XCTAssertEqual(sends[0].userMessage, expected)
    XCTAssertTrue(sends.allSatisfy(\.hasTextContent))
    XCTAssertEqual(
      sends[0].userMessage.parts.first?["threadId"]?.string, MentionNavigationFixture.thread(31))
    XCTAssertEqual(sends[0].clientEventId, sends[1].clientEventId)
  }

  private func mentionKey(_ key: String, input: ComposerTextView) async throws {
    // IME confirmation settles on a later UIKit turn than the business document.
    try await eventually {
      input.keyCommands?.contains { $0.input == key && $0.modifierFlags.isEmpty } == true
    }
    let command = try XCTUnwrap(
      input.keyCommands?.first { $0.input == key && $0.modifierFlags.isEmpty })
    XCTAssertTrue(
      UIApplication.shared.sendAction(
        try XCTUnwrap(command.action), to: input, from: command, for: nil))
  }

  func testLateStructuredPasteAndCandidateStayWithTheirDraftAfterOpeningAChat() async throws {
    let navigation = MentionNavigationFixture()
    let workspace = try await navigation.workspace()
    defer { workspace.close() }
    let originalComposer = workspace.newComposer
    // Keep the old native editor mounted while its draft is no longer selected.
    // The callback must reach that owner rather than race SwiftUI's teardown.
    let host = UIHostingController(
      rootView: MentionComposerHarness(
        state: originalComposer, source: workspace.mentionTestSource))
    let window = try await mountMentionHost(host)
    addTeardownBlock { @MainActor in unmount(window) }
    let input = try XCTUnwrap(mentionInputs(in: host.view).first)
    try await focusMentionInput(input)
    input.insertText("@pl")
    try await eventually { mentionTable(in: host.view)?.visibleCells.first != nil }
    let retiredRow = try XCTUnwrap(mentionTable(in: host.view)?.visibleCells.first)
    let started = expectation(description: "Structured clipboard provider started")
    let delivery = DelayedProviderTasks(owner: self)
    let data = Data(
      #"{"version":1,"parts":[{"type":"agent","agentId":"73000000-0000-4000-8000-000000000003","nameSnapshot":"Notes"}]}"#
        .utf8)
    let provider = NSItemProvider()
    provider.registerDataRepresentation(
      forTypeIdentifier: ComposerAttributedDocument.pasteboardType, visibility: .all
    ) { callback in
      started.fulfill()
      return delivery.hold { callback(data, nil) }
    }
    input.paste(itemProviders: [provider])
    await fulfillment(of: [started], timeout: 3)
    workspace.selectChat(MentionNavigationFixture.thread(31))
    // Exercise the old callbacks after selecting another composer, independently
    // of when SwiftUI dismantles the old editor.
    XCTAssertTrue(retiredRow.accessibilityActivate())
    delivery.release()
    try await waitForBusinessResult {
      originalComposer.document.parts.contains {
        $0["type"]?.string == "agent" && $0["agentId"]?.string == MentionNavigationFixture.agent(3)
      }
    }
    try await eventually { mentionTable(in: host.view) == nil }
    XCTAssertFalse(workspace.selectedConversation?.composer.hasContent ?? true)
    XCTAssertEqual(workspace.selectedAgentID, MentionNavigationFixture.agent(1))
    XCTAssertNil(mentionTable(in: host.view))
  }
}

@MainActor
private final class NativePasteTrace {
  let started = ContinuousClock.now
  var nativeChange: Duration?
  var canonicalAtNativeChange: Bool?
  private(set) var stages: [(String, Duration)] = []

  func record(_ stage: String) {
    stages.append((stage, started.duration(to: .now)))
  }
}

/// Observe the production transform without replacing its provider or UIKit insertion.
@MainActor
private final class NativePasteDelegate: NSObject, UITextPasteDelegate {
  let delegate: ChatComposerTextInput.Coordinator
  let trace: NativePasteTrace

  init(delegate: ChatComposerTextInput.Coordinator, trace: NativePasteTrace) {
    self.delegate = delegate
    self.trace = trace
  }

  func textPasteConfigurationSupporting(
    _ textPasteConfigurationSupporting: UITextPasteConfigurationSupporting,
    transform item: UITextPasteItem
  ) {
    trace.record("transform started")
    delegate.textPasteConfigurationSupporting(
      textPasteConfigurationSupporting, transform: NativePasteItem(item: item, trace: trace))
  }
}

@MainActor
private final class NativePasteItem: NSObject, UITextPasteItem {
  let item: UITextPasteItem
  let trace: NativePasteTrace

  init(item: UITextPasteItem, trace: NativePasteTrace) {
    self.item = item
    self.trace = trace
  }

  var itemProvider: NSItemProvider { item.itemProvider }
  var localObject: Any? { item.localObject }
  var defaultAttributes: [NSAttributedString.Key: Any] { item.defaultAttributes }

  func setResult(string: String) {
    complete("string") { item.setResult(string: string) }
  }

  func setResult(attributedString: NSAttributedString) {
    complete("attributed string") { item.setResult(attributedString: attributedString) }
  }

  func setResult(attachment: NSTextAttachment) {
    complete("attachment") { item.setResult(attachment: attachment) }
  }

  func setDefaultResult() {
    complete("default") { item.setDefaultResult() }
  }

  func setNoResult() {
    complete("no result") { item.setNoResult() }
  }

  private func complete(_ result: String, _ action: () -> Void) {
    // Preparation includes provider loading and the production MainActor hop.
    trace.record("\(result) submitted")
    action()
    trace.record("\(result) returned")
  }
}

struct MentionSend: Decodable {
  let userMessage: ChatDraftDocument
  let agentId: String
  let clientEventId: String
  let hasTextContent: Bool
}
