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
    let overview = source.suggestions(for: "")
    let agents = overview.filter { $0.kind == .agent }
    let chats = overview.filter { $0.kind == .chat }
    XCTAssertEqual(agents.map(\.referenceID), (1...3).map(MentionNavigationFixture.agent))
    XCTAssertEqual(chats.count, 25)
    // Sidebar pinOrder puts the older pin first; mention ordering uses activity.
    XCTAssertEqual(chats.first?.referenceID, MentionNavigationFixture.thread(35))
    XCTAssertEqual(chats.dropFirst().first?.referenceID, MentionNavigationFixture.thread(34))
    let filtered = source.suggestions(for: "pLaN")
    XCTAssertEqual(
      filtered.map(\.referenceID),
      [MentionNavigationFixture.agent(1), MentionNavigationFixture.thread(31)])
    XCTAssertEqual(filtered.map(\.title), ["Planner", "Cross Agent archived plan"])

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
    try await eventually {
      workspace.newComposer.document.parts.contains { $0["type"]?.string == "agent" }
    }
    XCTAssertEqual(input.selectedRange, NSRange(location: 9, length: 0))
    XCTAssertEqual(input.text, "Before \u{fffc} after 🌷")
    XCTAssertTrue(input.isFirstResponder)
    input.insertText("and @project")
    try await eventually {
      mentionTable(in: host.view)?.visibleCells.first?.accessibilityLabel == "Chat: Project 30"
    }
    input.insertText("\n")
    try await eventually {
      workspace.newComposer.document.parts.filter { $0["type"]?.string == "chat_thread" }.count == 1
    }
    let expected = workspace.newComposer.document
    XCTAssertEqual(
      expected.parts.map { $0["type"]?.string }, ["text", "agent", "text", "chat_thread", "text"])
    XCTAssertEqual(expected.text, "Before  and  after 🌷")
    XCTAssertEqual(input.text, "Before \u{fffc} and \u{fffc} after 🌷")
    await hostingPresentationFrame()

    input.selectedRange = NSRange(location: 7, length: 1)
    input.deleteBackward()
    try await eventually {
      !workspace.newComposer.document.parts.contains { $0["type"]?.string == "agent" }
    }
    await hostingPresentationFrame()
    input.undoManager?.undo()
    try await eventually(
      message:
        "After deletion undo: \(workspace.newComposer.document); text: \(String(describing: input.text))"
    ) { workspace.newComposer.document == expected }
    input.undoManager?.redo()
    try await eventually {
      !workspace.newComposer.document.parts.contains { $0["type"]?.string == "agent" }
    }
    input.undoManager?.undo()
    try await eventually { workspace.newComposer.document == expected }

    input.selectedRange = NSRange(location: 0, length: input.text.utf16.count)
    input.copy(nil)
    XCTAssertTrue(UIPasteboard.general.string?.contains("/agents/") == true)
    XCTAssertTrue(UIPasteboard.general.string?.contains("/chats/") == true)
    input.cut(nil)
    try await eventually { !workspace.newComposer.hasContent }
    input.paste(nil)
    try await eventually { workspace.newComposer.document == expected }
    input.undoManager?.undo()
    try await eventually { !workspace.newComposer.hasContent }
    input.undoManager?.redo()
    try await eventually { workspace.newComposer.document == expected }

    input.selectedRange = NSRange(location: 0, length: input.text.utf16.count)
    input.insertText("Replacement 中文")
    try await eventually {
      workspace.newComposer.document.parts.count == 1 && workspace.newChatDraft == "Replacement 中文"
    }
    input.undoManager?.undo()
    try await eventually { workspace.newComposer.document == expected }
  }

  func testNativeMarkedTextConfirmationDoesNotInsertAMentionAndKeyboardNavigatesGroups()
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
    input.insertText("person@example.com")
    await hostingPresentationFrame()
    XCTAssertNil(mentionTable(in: host.view))
    input.insertText("\n@")
    try await eventually { mentionTable(in: host.view) != nil }
    input.setMarkedText("研究", selectedRange: NSRange(location: 2, length: 0))
    try await eventually { input.markedTextRange != nil && mentionTable(in: host.view) == nil }
    XCTAssertFalse(input.keyCommands?.contains { $0.input == "\r" } == true)
    input.unmarkText()
    input.insertText("\n")
    try await eventually {
      workspace.newChatDraft.contains("研究\n") && mentionTable(in: host.view) == nil
    }
    XCTAssertFalse(workspace.newComposer.document.parts.contains { $0["type"]?.string == "agent" })
    input.insertText("@")
    try await eventually { mentionTable(in: host.view)?.numberOfSections == 2 }
    for _ in 0..<3 { try mentionKey(UIKeyCommand.inputDownArrow, input: input) }
    input.insertText("\n")
    try await eventually {
      workspace.newComposer.document.parts.contains {
        $0["titleSnapshot"]?.string == "Pinned recent"
      }
    }
    XCTAssertTrue(input.isFirstResponder)
    XCTAssertTrue(navigation.paths.value.withLock { $0.allSatisfy { !$0.contains("/search") } })
    input.insertText("@")
    try await eventually { mentionTable(in: host.view)?.numberOfSections == 2 }
    try mentionKey(UIKeyCommand.inputEscape, input: input)
    try await eventually { mentionTable(in: host.view) == nil }
    XCTAssertTrue(input.isFirstResponder)
    input.insertText("missing")
    await hostingPresentationFrame()
    XCTAssertNil(mentionTable(in: host.view))
    input.insertText("\n")
    XCTAssertTrue(input.text.hasSuffix("missing\n"))
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
    let reference = try XCTUnwrap(
      workspace.mentionTestSource.suggestions(for: "pl").first { $0.kind == .agent })
    let expected = ChatDraftDocument(parts: [
      reference.part, .object(["type": .string("text"), "text": .string(" ")]),
    ])
    let block = try XCTUnwrap(conversation.composer.editorBlocks.first)
    conversation.composer.editBlock(block.id, document: expected)
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
    let chat = try XCTUnwrap(source.suggestions(for: "plan").first { $0.kind == .chat })
    let agent = try XCTUnwrap(source.suggestions(for: "pl").first { $0.kind == .agent })
    let note = ChatDraftDocument(parts: [
      .object(["type": .string("text"), "text": .string("Compare ")]),
      chat.part,
      .object(["type": .string("text"), "text": .string(" with ")]),
      agent.part,
      .object(["type": .string("text"), "text": .string(" ")]),
    ])
    conversation.composer.editBlock(block, document: note)
    let file = FileManager.default.temporaryDirectory.appendingPathComponent(
      UUID().uuidString + ".txt")
    defer { try? FileManager.default.removeItem(at: file) }
    try Data("Reference comparison".utf8).write(to: file)
    conversation.attachmentDraft.importFiles([file])
    try await eventually {
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
    workspace.selectedAgentID = AttachmentFlowFixture.agentID
    let navigation = MentionNavigationFixture()
    let candidates = try await navigation.workspace()
    defer {
      workspace.close()
      candidates.close()
    }
    let reference = try XCTUnwrap(
      candidates.mentionTestSource.suggestions(for: "plan").first { $0.kind == .chat })
    let expected = ChatDraftDocument(parts: [
      reference.part, .object(["type": .string("text"), "text": .string(" ")]),
    ])
    let block = try XCTUnwrap(workspace.newComposer.editorBlocks.first)
    workspace.newComposer.editBlock(block.id, document: expected)
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

  private func mentionKey(_ key: String, input: ComposerTextView) throws {
    let command = try XCTUnwrap(
      input.keyCommands?.first { $0.input == key && $0.modifierFlags.isEmpty })
    XCTAssertTrue(
      UIApplication.shared.sendAction(
        try XCTUnwrap(command.action), to: input, from: command, for: nil))
  }

  func testLateStructuredPasteAndRetiredCandidateCannotEnterAnotherAgentDraft() async throws {
    let navigation = MentionNavigationFixture()
    let workspace = try await navigation.workspace()
    defer { workspace.close() }
    let host = UIHostingController(rootView: MentionComposerHarness(workspace: workspace))
    let window = try await mountMentionHost(host)
    addTeardownBlock { @MainActor in unmount(window) }
    let input = try XCTUnwrap(mentionInputs(in: host.view).first)
    let pasteDelegate = try XCTUnwrap(input.pasteDelegate)
    try await focusMentionInput(input)
    input.insertText("@pl")
    try await eventually { mentionTable(in: host.view)?.visibleCells.first != nil }
    let retiredRow = try XCTUnwrap(mentionTable(in: host.view)?.visibleCells.first)
    let started = expectation(description: "Structured clipboard provider started")
    let probeStarted = expectation(description: "The production paste transform requested its data")
    let consumed = expectation(description: "The production paste transform resolved its result")
    let delivery = DelayedProviderTasks(owner: self)
    let data = Data(
      #"{"version":1,"parts":[{"type":"agent","agentId":"73000000-0000-4000-8000-000000000001","nameSnapshot":"Planner"}]}"#
        .utf8)
    let provider = NSItemProvider()
    provider.registerDataRepresentation(
      forTypeIdentifier: ComposerAttributedDocument.pasteboardType, visibility: .all
    ) { callback in
      started.fulfill()
      return delivery.hold { callback(data, nil) }
    }
    input.paste(itemProviders: [provider])
    // Keep the native paste above, and independently observe the real delegate's
    // consumer result through UIKit's public paste-item protocol.
    let probeProvider = NSItemProvider()
    probeProvider.registerDataRepresentation(
      forTypeIdentifier: ComposerAttributedDocument.pasteboardType, visibility: .all
    ) { callback in
      probeStarted.fulfill()
      return delivery.hold { callback(data, nil) }
    }
    let item = PasteResultItem(provider: probeProvider, completed: consumed)
    pasteDelegate.textPasteConfigurationSupporting?(input, transform: item)
    await fulfillment(of: [started, probeStarted], timeout: 3)
    workspace.startNewChat(agentID: MentionNavigationFixture.agent(2))
    try await eventually { mentionInputs(in: host.view).first !== input && input.delegate == nil }
    XCTAssertTrue(retiredRow.accessibilityActivate())
    delivery.release()
    await fulfillment(of: [consumed], timeout: 3)
    XCTAssertEqual(item.outcome, .noResult)
    await hostingPresentationFrame()
    XCTAssertFalse(workspace.newComposer.hasContent)
    XCTAssertEqual(workspace.selectedAgentID, MentionNavigationFixture.agent(2))
    XCTAssertNil(mentionTable(in: host.view))
  }
}

struct MentionSend: Decodable {
  let userMessage: ChatDraftDocument
  let agentId: String
  let clientEventId: String
  let hasTextContent: Bool
}
