import ChatData
import ChatDataTestSupport
import ChatDomain
import SwiftUI
import UniformTypeIdentifiers
import XCTest

@testable import Okou

@MainActor
final class ChatComposerMentionTests: XCTestCase {
  func testNativeCandidatesMatchWorkspaceScopeOrderingFilteringAndLimits() async throws {
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
    input.insertText(" @")
    try await eventually(
      message:
        "Text: \(String(describing: input.text)); focused: \(input.isFirstResponder); query: \(String(describing: workspace.newComposer.editor.mentionQuery))"
    ) { mentionTable(in: host.view)?.numberOfSections == 2 }
    var table = try XCTUnwrap(mentionTable(in: host.view))
    XCTAssertEqual(table.numberOfRows(inSection: 0), 3)
    XCTAssertEqual(table.numberOfRows(inSection: 1), 25)
    XCTAssertEqual(table.dataSource?.tableView?(table, titleForHeaderInSection: 0), "Agents")
    XCTAssertEqual(table.dataSource?.tableView?(table, titleForHeaderInSection: 1), "Chats")
    XCTAssertEqual(
      table.cellForRow(at: IndexPath(row: 0, section: 0))?.accessibilityLabel, "Agent: Planner")
    // Sidebar pinOrder puts the older pin first; mention ordering uses activity.
    table.scrollToRow(at: IndexPath(row: 0, section: 1), at: .top, animated: false)
    try await eventually { table.cellForRow(at: IndexPath(row: 0, section: 1)) != nil }
    XCTAssertEqual(
      table.cellForRow(at: IndexPath(row: 0, section: 1))?.accessibilityLabel, "Chat: Pinned recent"
    )
    XCTAssertTrue(input.isFirstResponder)
    attachMention(window, name: "Native grouped mention search (HTTP fixtures)")

    input.insertText("pLaN")
    try await eventually { mentionTable(in: host.view)?.numberOfRows(inSection: 1) == 1 }
    table = try XCTUnwrap(mentionTable(in: host.view))
    XCTAssertEqual(table.numberOfRows(inSection: 0), 1)
    XCTAssertEqual(
      table.cellForRow(at: IndexPath(row: 0, section: 0))?.accessibilityLabel, "Agent: Planner")
    XCTAssertEqual(
      table.cellForRow(at: IndexPath(row: 0, section: 1))?.accessibilityLabel,
      "Chat: Cross Agent archived plan")

    // The current chat is a valid reference, as on the PWA.
    input.selectedRange = NSRange(location: 0, length: input.text.utf16.count)
    input.insertText("@Current")
    try await eventually { mentionTable(in: host.view)?.numberOfSections == 1 }
    table = try XCTUnwrap(mentionTable(in: host.view))
    XCTAssertEqual(
      table.cellForRow(at: IndexPath(row: 0, section: 0))?.accessibilityLabel,
      "Chat: Current conversation")
    try mentionKey(UIKeyCommand.inputEscape, input: input)
    try await eventually { mentionTable(in: host.view) == nil }
    XCTAssertTrue(input.isFirstResponder)
    input.insertText("missing")
    await hostingPresentationFrame()
    XCTAssertNil(mentionTable(in: host.view))
    XCTAssertFalse(input.keyCommands?.contains { $0.input == UIKeyCommand.inputDownArrow } == true)
    input.insertText("\n")
    XCTAssertTrue(input.text.hasSuffix("\n"))
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
    attachMention(window, name: "Native multiple inline references (HTTP fixtures)")
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
    input.insertText("@")
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
    let host = UIHostingController(
      rootView: MentionComposerHarness(
        conversation: conversation, source: workspace.mentionTestSource))
    let window = try await mountMentionHost(host)
    defer { unmount(window) }
    let input = try XCTUnwrap(mentionInputs(in: host.view).first)
    try await focusMentionInput(input)
    input.insertText("@pl")
    try await eventually { mentionTable(in: host.view) != nil }
    input.insertText("\n")
    try await eventually { conversation.composer.document.parts.first?["type"]?.string == "agent" }
    let expected = conversation.composer.value.draftUserMessage
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
    host.rootView = MentionComposerHarness(
      conversation: conversation, source: workspace.mentionTestSource, sent: sent)
    try await eventually { mentionInputs(in: host.view).first?.text == "Next draft" }
    attachMention(window, name: "Native sent reference and retry recovery (HTTP fixtures)")
  }

  func testQuotedNotesMixReferencesAndAttachmentsWithoutChangingQuoteSource() async throws {
    preserveNativePasteboard(for: self)
    let fixture = AttachmentFlowFixture()
    let conversation = fixture.conversation()
    let navigation = MentionNavigationFixture()
    let workspace = try await navigation.workspace()
    defer {
      conversation.close()
      workspace.close()
    }
    let host = UIHostingController(
      rootView: MentionComposerHarness(
        conversation: conversation, source: workspace.mentionTestSource))
    let window = try await mountMentionHost(host)
    defer { unmount(window) }
    let message = ChatMessage(
      id: "quoted-event", role: .assistant, text: "A passage to compare", createdAt: .now,
      isQueued: false, isError: false)
    let quote = try XCTUnwrap(
      ChatFeedbackSelection(
        message: message, range: NSRange(location: 0, length: message.text.utf16.count)))
    conversation.composer.addFeedback(quote)
    try await eventually {
      mentionInputs(in: host.view).contains {
        $0.isFirstResponder && $0.accessibilityLabel == "Ask or comment on this quote"
      }
    }
    let note = try XCTUnwrap(mentionInputs(in: host.view).first(where: \.isFirstResponder))
    note.insertText("Compare @plan")
    try await eventually { mentionTable(in: host.view)?.numberOfSections == 2 }
    let table = try XCTUnwrap(mentionTable(in: host.view))
    let row = try XCTUnwrap(table.cellForRow(at: IndexPath(row: 0, section: 1)))
    XCTAssertTrue(row.accessibilityActivate())
    try await eventually {
      conversation.composer.editorBlocks.first(where: \.isFeedback)?.content.parts.contains {
        $0["type"]?.string == "chat_thread"
      } == true
    }
    note.insertText("with @pl")
    try await eventually { mentionTable(in: host.view) != nil }
    note.insertText("\n")
    let png = UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8)).image { _ in
      UIColor.blue.setFill()
      UIBezierPath(rect: CGRect(x: 0, y: 0, width: 8, height: 8)).fill()
    }.pngData()!
    UIPasteboard.general.setItems([[UTType.png.identifier: png]], options: [.localOnly: true])
    note.paste(nil)
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
    XCTAssertTrue(note.isFirstResponder)
    attachMention(window, name: "Native quoted note with references and attachment (HTTP fixtures)")
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
    let host = UIHostingController(
      rootView: MentionComposerHarness(workspace: workspace, source: candidates.mentionTestSource))
    let window = try await mountMentionHost(host)
    defer { unmount(window) }
    let input = try XCTUnwrap(mentionInputs(in: host.view).first)
    try await focusMentionInput(input)
    input.insertText("@plan")
    try await eventually { mentionTable(in: host.view)?.numberOfSections == 2 }
    let row = try XCTUnwrap(
      mentionTable(in: host.view)?.cellForRow(at: IndexPath(row: 0, section: 1)))
    XCTAssertTrue(row.accessibilityActivate())
    let expected = workspace.newComposer.value.draftUserMessage
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
    defer { unmount(window) }
    let input = try XCTUnwrap(mentionInputs(in: host.view).first)
    try await focusMentionInput(input)
    input.insertText("@pl")
    try await eventually { mentionTable(in: host.view)?.visibleCells.first != nil }
    let retiredRow = try XCTUnwrap(mentionTable(in: host.view)?.visibleCells.first)
    let started = expectation(description: "Structured clipboard provider started")
    let delivered = expectation(description: "Structured clipboard provider delivered")
    let (stream, continuation) = AsyncStream<Void>.makeStream()
    defer { continuation.finish() }
    let provider = NSItemProvider()
    provider.registerDataRepresentation(
      forTypeIdentifier: ComposerAttributedDocument.pasteboardType, visibility: .all
    ) { callback in
      started.fulfill()
      Task {
        for await _ in stream { break }
        callback(
          Data(
            #"{"version":1,"parts":[{"type":"agent","agentId":"73000000-0000-4000-8000-000000000001","nameSnapshot":"Planner"}]}"#
              .utf8), nil)
        delivered.fulfill()
      }
      return Progress(totalUnitCount: 1)
    }
    input.paste(itemProviders: [provider])
    await fulfillment(of: [started], timeout: 3)
    workspace.startNewChat(agentID: MentionNavigationFixture.agent(2))
    try await eventually { mentionInputs(in: host.view).first !== input && input.delegate == nil }
    XCTAssertTrue(retiredRow.accessibilityActivate())
    continuation.yield()
    await fulfillment(of: [delivered], timeout: 3)
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
