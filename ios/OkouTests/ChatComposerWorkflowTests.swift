import ChatData
import ChatDataTestSupport
import ChatDomain
import SwiftUI
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class ChatComposerWorkflowTests: XCTestCase {
  func testWorkflowInsertionAndUndoPreserveNativeAgentAndChatReferences() async throws {
    let fixture = MentionNavigationFixture(workflows: { _ in
      ChatHTTPResponse(body: workflowResponse)
    })
    let workspace = try await fixture.workspace()
    defer { workspace.close() }
    let host = UIHostingController(rootView: WorkflowNewChatHost(workspace: workspace))
    let window = try await mountMentionHost(host)
    defer { unmount(window) }
    let input = try XCTUnwrap(inputs(in: host.view).first)
    try await focusMentionInput(input)
    input.insertText("Before @")
    let agent = try XCTUnwrap(
      workspace.mentionTestSource.suggestions(for: "").first { $0.kind == .agent })
    try await waitForBusinessResult {
      workspace.newComposer.editor.mentionSuggestions.contains(agent)
    }
    workspace.newComposer.editor.insertMention(agent)
    let references = workspace.newComposer.document.parts.filter { $0["type"]?.string != "text" }
    XCTAssertEqual(references.map { $0["type"]?.string }, ["agent"])
    input.insertText(" /rel after")
    let slash = (input.text as NSString).range(of: "/rel")
    input.selectedRange = NSRange(location: NSMaxRange(slash), length: 0)
    let workflow = try await workflowCell("release", in: host.view)
    XCTAssertTrue(workflow.accessibilityActivate())
    try await eventually { input.text.contains("/release after") }
    XCTAssertEqual(
      workspace.newComposer.document.parts.filter { $0["type"]?.string != "text" }, references)
    XCTAssertTrue(input.isFirstResponder)
    await hostingPresentationFrame()
    input.undoManager?.undo()
    try await eventually { input.text.contains("/rel after") }
    XCTAssertEqual(
      workspace.newComposer.document.parts.filter { $0["type"]?.string != "text" }, references)
    input.undoManager?.redo()
    try await eventually { input.text.contains("/release after") }
    input.selectedRange = NSRange(location: input.text.utf16.count, length: 0)
    input.insertText(" @")
    let chat = try XCTUnwrap(
      workspace.mentionTestSource.suggestions(for: "").first { $0.kind == .chat })
    try await waitForBusinessResult {
      workspace.newComposer.editor.mentionSuggestions.contains(chat)
    }
    workspace.newComposer.editor.insertMention(chat)
    XCTAssertEqual(
      workspace.newComposer.document.parts.filter { $0["type"]?.string != "text" }.map {
        $0["type"]?.string
      }, ["agent", "chat_thread"])
    XCTAssertTrue(input.text.contains("/release after"))
    XCTAssertNil(workflowTable(in: host.view))
    XCTAssertTrue(input.isFirstResponder)
  }

  func testWorkflowInsertionUsesOnlyTheActiveUTF16TokenAndKeepsFocusAndUndo() async throws {
    let fixture = workflowFixture()
    let source = ComposerWorkflowSource(
      client: fixture.http.client, storage: nil, didFail: { _ in })
    let conversation = fixture.conversation(workflowSource: source)
    defer {
      conversation.close()
      source.close()
    }
    let host = UIHostingController(rootView: composer(conversation))
    let window = try await mountMentionHost(host)
    defer { unmount(window) }
    let input = try XCTUnwrap(inputs(in: host.view).first)
    try await focusMentionInput(input)
    input.insertText("🌷 Keep /rel tail")
    input.selectedRange = NSRange(location: "🌷 Keep /rel".utf16.count, length: 0)
    let workflow = try await workflowCell("release", in: host.view)
    XCTAssertTrue(workflow.accessibilityActivate())
    try await eventually { conversation.draft == "🌷 Keep /release tail" }
    XCTAssertEqual(input.selectedRange, NSRange(location: "🌷 Keep /release".utf16.count, length: 0))
    XCTAssertTrue(input.isFirstResponder)
    XCTAssertTrue(source.recentIDs().isEmpty)
    XCTAssertTrue(fixture.state.value.withLock { $0.messages.isEmpty })
    await hostingPresentationFrame()
    input.undoManager?.undo()
    try await eventually { conversation.draft == "🌷 Keep /rel tail" }
    input.undoManager?.redo()
    try await eventually { conversation.draft == "🌷 Keep /release tail" }
    input.insertText(" edited")
    XCTAssertTrue(conversation.draft.contains("edited"))
  }

  func testNativeSelectionAndEscapePreventWorkflowInsertionAndNumericQueryInsertsOnlyItsMatch()
    async throws
  {
    let fixture = workflowFixture()
    let source = ComposerWorkflowSource(
      client: fixture.http.client, storage: nil, didFail: { _ in })
    let conversation = fixture.conversation(workflowSource: source)
    defer {
      conversation.close()
      source.close()
    }
    let host = UIHostingController(rootView: composer(conversation))
    let window = try await mountMentionHost(host)
    defer { unmount(window) }
    let input = try XCTUnwrap(inputs(in: host.view).first)
    try await focusMentionInput(input)
    try await type("First paragraph\n/release", in: input, conversation: conversation)
    let workflows = conversation.composer.editor.workflows
    try await waitForBusinessResult { workflows.matches.contains { $0.id == "release" } }
    input.selectedRange = NSRange(location: 0, length: 5)
    try await waitForBusinessResult { workflows.query == nil }
    XCTAssertFalse(workflows.handleKey("\r", in: input))
    XCTAssertEqual(conversation.draft, "First paragraph\n/release")
    input.selectedRange = NSRange(location: input.text.utf16.count, length: 0)
    try await waitForBusinessResult { workflows.matches.contains { $0.id == "release" } }
    XCTAssertTrue(workflows.handleKey(UIKeyCommand.inputEscape, in: input))
    XCTAssertFalse(workflows.handleKey("\r", in: input))
    XCTAssertEqual(conversation.draft, "First paragraph\n/release")
    XCTAssertTrue(input.isFirstResponder)
    try await type("/r12", in: input, conversation: conversation)
    try await waitForBusinessResult { workflows.matches.contains { $0.id == "12" } }
    let numeric = try XCTUnwrap(workflows.matches.first { $0.id == "12" })
    workflows.insert(numeric)
    try await waitForBusinessResult { conversation.draft == "/report-12 " }
    try await type("/r14", in: input, conversation: conversation)
    try await waitForBusinessResult { !workflows.isLoading }
    input.insertText("\n")
    XCTAssertEqual(conversation.draft, "/r14\n")
  }

  func testMarkedTextConfirmationCannotInsertWorkflowAndKeyboardSelectionDoesNotSend() async throws
  {
    let fixture = workflowFixture()
    let source = ComposerWorkflowSource(
      client: fixture.http.client, storage: nil, didFail: { _ in })
    let conversation = fixture.conversation(workflowSource: source)
    defer {
      conversation.close()
      source.close()
    }
    let host = UIHostingController(rootView: composer(conversation))
    let window = try await mountMentionHost(host)
    defer { unmount(window) }
    let input = try XCTUnwrap(inputs(in: host.view).first)
    try await focusMentionInput(input)
    input.insertText("/")
    let savedRow = try await workflowCell("morning", in: host.view)
    input.setMarkedText("rel", selectedRange: NSRange(location: 3, length: 0))
    XCTAssertNotNil(input.markedTextRange)
    XCTAssertTrue(savedRow.accessibilityActivate())
    XCTAssertEqual(input.text, "/rel")
    input.unmarkText()
    input.insertText("\n")
    XCTAssertEqual(input.text, "/rel\n")
    XCTAssertTrue(fixture.state.value.withLock { $0.messages.isEmpty })
    try await type("/rel", in: input, conversation: conversation)
    _ = try await workflowCell("release", in: host.view)
    let down = try XCTUnwrap(input.keyCommands?.first { $0.input == UIKeyCommand.inputDownArrow })
    _ = input.perform(down.action, with: down)
    let confirm = try XCTUnwrap(input.keyCommands?.first { $0.input == "\r" })
    XCTAssertEqual(confirm.modifierFlags, [])
    _ = input.perform(confirm.action, with: confirm)
    try await eventually { conversation.draft == "/release " }
    XCTAssertTrue(input.isFirstResponder)
    XCTAssertTrue(fixture.state.value.withLock { $0.messages.isEmpty })
  }

  func testWorkflowHTTPFailureCanBeRetriedAndClosedWorkspaceRejectsLateResults() async throws {
    let gate = WorkflowGate()
    let started = expectation(description: "Old Agent Workflow request")
    let attempts = WorkflowCounter()
    let fixture = AttachmentFlowFixture(workflows: { request in
      let agent = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?
        .first { $0.name == "agentId" }?.value
      if agent == AttachmentFlowFixture.agentID {
        started.fulfill()
        await gate.wait()
        return ChatHTTPResponse(body: workflowResponse)
      }
      let count = attempts.value.withLock {
        $0 += 1
        return $0
      }
      return count == 1
        ? ChatHTTPResponse(
          status: 503, body: #"{"error":{"message":"Workflows temporarily unavailable"}}"#)
        : ChatHTTPResponse(
          body:
            #"[{"id":"fresh","name":"fresh","displayName":null,"description":"Current Agent only"}]"#
        )
    })
    let workspace = WorkspaceStore(client: fixture.http.client, webURL: fixture.http.baseURL)
    defer { workspace.close() }
    await workspace.refreshNavigation()
    let source = workspace.composerWorkflows
    let old = Task { try await source.load(agentID: AttachmentFlowFixture.agentID) }
    addTeardownBlock {
      old.cancel()
      gate.open()
      _ = try? await old.value
    }
    await fulfillment(of: [started], timeout: 3)
    workspace.startNewChat(agentID: "other-agent")
    do {
      _ = try await source.load(agentID: "other-agent")
      XCTFail("The HTTP failure must remain visible to the caller")
    } catch {
      XCTAssertEqual(error.localizedDescription, "Workflows temporarily unavailable")
    }
    let current = try await source.load(agentID: "other-agent")
    XCTAssertEqual(current.map(\.name), ["fresh"])
    workspace.close()
    gate.open()
    do {
      _ = try await old.value
      XCTFail("A closed workspace must not accept a late Workflow response")
    } catch is CancellationError {}
  }

  func testRetiredWorkflowRowsCannotChangeReplacementInputOrClosedWorkspaceDraft() async throws {
    let fixture = AttachmentFlowFixture(workflows: { request in
      let agent = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?
        .first { $0.name == "agentId" }?.value
      return agent == AttachmentFlowFixture.agentID
        ? ChatHTTPResponse(body: workflowResponse)
        : ChatHTTPResponse(
          body: #"[{"id":"fresh","name":"fresh","displayName":null,"description":null}]"#)
    })
    let workspace = WorkspaceStore(client: fixture.http.client, webURL: fixture.http.baseURL)
    defer { workspace.close() }
    await workspace.refreshNavigation()
    let host = UIHostingController(rootView: WorkflowNewChatHost(workspace: workspace))
    let window = try await mountMentionHost(host)
    defer { unmount(window) }
    let old = try XCTUnwrap(inputs(in: host.view).first)
    try await focusMentionInput(old)
    old.insertText("/rel")
    let retired = try await workflowCell("release", in: host.view)
    workspace.startNewChat(agentID: "other-agent")
    try await eventually { self.inputs(in: host.view).first !== old }
    let current = try XCTUnwrap(inputs(in: host.view).first)
    try await focusMentionInput(current)
    current.insertText("/")
    let fresh = try await workflowCell("fresh", in: host.view)
    XCTAssertTrue(retired.accessibilityActivate())
    XCTAssertEqual(current.text, "/")
    XCTAssertEqual(workspace.newComposer.text, "/")
    workspace.close()
    XCTAssertTrue(fresh.accessibilityActivate())
    XCTAssertEqual(current.text, "/")
    XCTAssertEqual(workspace.newComposer.text, "/")
  }

  func testRecentUseIsRecordedAfterSuccessfulRetryAndPersistsWithinWorkspaceOnly() async throws {
    let fixture = workflowFixture(failSend: true)
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let scope = ChatCacheScope(apiBaseURL: fixture.http.baseURL, userID: "user", workspaceID: "one")
    let storage = ChatDraftStorage(scope: scope, directory: directory)
    let source = ComposerWorkflowSource(
      client: fixture.http.client, storage: storage, didFail: { _ in })
    let conversation = fixture.conversation(workflowSource: source)
    defer {
      conversation.close()
      source.close()
    }
    conversation.draft = "/release "
    XCTAssertTrue(source.recentIDs().isEmpty)
    await conversation.send()
    XCTAssertTrue(source.recentIDs().isEmpty)
    let pending = try XCTUnwrap(conversation.pending.first)
    XCTAssertTrue(pending.needsRetry)
    await conversation.retry(pending)
    XCTAssertEqual(source.recentIDs(), ["release"])
    let reopened = ComposerWorkflowSource(
      client: fixture.http.client, storage: storage, didFail: { _ in })
    defer { reopened.close() }
    XCTAssertEqual(reopened.recentIDs(), ["release"])
    let other = ComposerWorkflowSource(
      client: fixture.http.client,
      storage: ChatDraftStorage(
        scope: ChatCacheScope(apiBaseURL: fixture.http.baseURL, userID: "user", workspaceID: "two"),
        directory: directory), didFail: { _ in })
    defer { other.close() }
    XCTAssertTrue(other.recentIDs().isEmpty)
    let available = try await reopened.load(agentID: AttachmentFlowFixture.agentID)
    let recent = ComposerWorkflowSearch.matches(available, query: "", recent: reopened.recentIDs())
    XCTAssertEqual(recent.first?.name, "release")
  }

  func testQuotedNoteKeepsQuoteAndAttachmentAndRecordsOnlyTypedWorkflowAfterSend() async throws {
    let fixture = workflowFixture()
    let source = ComposerWorkflowSource(
      client: fixture.http.client, storage: nil, didFail: { _ in })
    let conversation = fixture.conversation(workflowSource: source)
    defer {
      conversation.close()
      source.close()
    }
    let message = ChatMessage(
      id: "assistant", role: .assistant, text: "Quoted /rel", createdAt: .now,
      isQueued: false, isError: false)
    let selection = try XCTUnwrap(
      ChatFeedbackSelection(
        message: message, range: NSRange(location: 0, length: message.text.utf16.count)))
    let note = try XCTUnwrap(conversation.composer.addFeedback(selection))
    conversation.composer.editBlock(note, text: "Please /release ")
    XCTAssertEqual(conversation.composer.document.parts.first?["quote"]?.string, "Quoted /rel")
    conversation.attachmentDraft.importFiles([try attachmentFile()])
    try await waitForBusinessResult {
      conversation.attachmentDraft.isReady && conversation.attachmentDraft.hasAttachments
    }
    await conversation.send()
    XCTAssertEqual(source.recentIDs(), ["release"])
    let body = try XCTUnwrap(fixture.state.value.withLock { $0.messages.first })
    let request = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
    let document = try XCTUnwrap(request["userMessage"] as? [String: Any])
    let parts = try XCTUnwrap(document["parts"] as? [[String: Any]])
    XCTAssertTrue(parts.contains { $0["type"] as? String == "file" })
    let feedback = try XCTUnwrap(parts.first { $0["type"] as? String == "feedback" })
    XCTAssertEqual(feedback["quote"] as? String, "Quoted /rel")
    XCTAssertEqual(
      (feedback["note"] as? [[String: Any]])?.first?["text"] as? String, "Please /release ")
  }

  func testNewChatWorkflowDraftSurvivesReopenAndFirstSendUsesTheExistingTextProtocol() async throws
  {
    let fixture = workflowFixture()
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let storage = ChatDraftStorage(
      scope: ChatCacheScope(
        apiBaseURL: fixture.http.baseURL, userID: "user", workspaceID: "workspace"),
      directory: directory)
    let workspace = WorkspaceStore(
      client: fixture.http.client, webURL: fixture.http.baseURL, draftStorage: storage)
    defer { workspace.close() }
    workspace.setForeground(true)
    await workspace.refreshNavigation()
    workspace.newChatDraft = "Summarize /morning-brief "
    XCTAssertEqual(workspace.newChatDraft, "Summarize /morning-brief ")
    XCTAssertTrue(fixture.state.value.withLock { $0.messages.isEmpty })
    await workspace.newComposer.synchronize()
    workspace.close()
    let reopened = WorkspaceStore(
      client: fixture.http.client, webURL: fixture.http.baseURL, draftStorage: storage)
    defer { reopened.close() }
    XCTAssertEqual(reopened.newChatDraft, "Summarize /morning-brief ")
    XCTAssertTrue(reopened.composerWorkflows.recentIDs().isEmpty)
    await reopened.sendNewChat()
    XCTAssertEqual(reopened.selectedThreadID, AttachmentFlowFixture.threadID)
    XCTAssertEqual(reopened.composerWorkflows.recentIDs(), ["morning"])
    let body = try XCTUnwrap(fixture.state.value.withLock { $0.messages.first })
    let sent = try JSONDecoder().decode(AttachmentFlowFixture.Message.self, from: body)
    XCTAssertEqual(sent.userMessage.parts.map(\.type), ["text"])
    XCTAssertEqual(sent.userMessage.parts.first?.text, "Summarize /morning-brief ")
  }

  private func workflowFixture(failSend: Bool = false) -> AttachmentFlowFixture {
    AttachmentFlowFixture(
      failSend: failSend,
      workflows: { request in
        let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems
        guard query == [URLQueryItem(name: "agentId", value: AttachmentFlowFixture.agentID)] else {
          throw URLError(.badURL)
        }
        return ChatHTTPResponse(body: workflowResponse)
      })
  }
  private func composer(_ conversation: ConversationStore) -> some View {
    ChatComposerView(
      draft: Binding(get: { conversation.draft }, set: { conversation.draft = $0 }),
      isBusy: conversation.isSending, showsProgress: false, canStop: false, needsUpgrade: false,
      error: conversation.error, attachmentURL: conversation.webURL,
      attachments: conversation.attachmentDraft, draftState: conversation.composer,
      submit: { await conversation.send() }, refresh: nil,
      workflowSource: conversation.workflowSource, agentID: conversation.thread.agentID
    )
    .frame(maxHeight: .infinity, alignment: .bottom)
    .background(Color(uiColor: .systemBackground))
    .composerWorkflowOverlay()
  }
  private func inputs(in view: UIView) -> [ComposerTextView] {
    if let view = view as? ComposerTextView { return [view] }
    return view.subviews.flatMap { inputs(in: $0) }
  }
  private func workflowTable(in view: UIView) -> UITableView? {
    if let table = view as? UITableView, table.accessibilityIdentifier == "workflow-suggestions" {
      return table
    }
    return view.subviews.compactMap { workflowTable(in: $0) }.first
  }
  private func workflowCell(_ id: String, in view: UIView) async throws -> UITableViewCell {
    func cell() -> UITableViewCell? {
      nativeViews(in: view).compactMap { $0 as? UITableViewCell }.first {
        $0.accessibilityIdentifier == "workflow-" + id
      }
    }
    try await eventually { cell() != nil }
    return try XCTUnwrap(cell())
  }
  private func type(_ text: String, in input: ComposerTextView, conversation: ConversationStore)
    async throws
  {
    input.selectedRange = NSRange(location: 0, length: input.text.utf16.count)
    input.insertText(text)
    try await eventually { conversation.draft == text }
    await hostingPresentationFrame()
  }
  private func attachmentFile() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(
      UUID().uuidString + ".txt")
    try Data("notes".utf8).write(to: url)
    addTeardownBlock { try? FileManager.default.removeItem(at: url) }
    return url
  }
}

private struct WorkflowNewChatHost: View {
  let workspace: WorkspaceStore
  var body: some View {
    @Bindable var composer = workspace.newComposer
    ChatComposerView(
      draft: $composer.text, isBusy: workspace.isCreating, showsProgress: false, canStop: false,
      needsUpgrade: workspace.needsUpgrade, error: workspace.error,
      attachmentURL: workspace.webURL, attachments: composer.attachments, draftState: composer,
      submit: { await workspace.sendNewChat() }, refresh: nil,
      mentionSource: workspace.mentionTestSource,
      workflowSource: workspace.composerWorkflows, agentID: workspace.selectedAgentID
    )
    .frame(maxHeight: .infinity, alignment: .bottom)
    .composerWorkflowOverlay()
  }
}

private let workflowResponse =
  #"[{"id":"release","name":"release","displayName":"Release notes","description":"Summarize the latest changes"},{"id":"rel","name":"rel","displayName":null,"description":"Quick release check"},{"id":"pre","name":"pre-release","displayName":null,"description":"Prepare a release"},{"id":"research","name":"research-notes","displayName":"Research notes","description":"Related release research"},{"id":"12","name":"report-12","displayName":null,"description":null},{"id":"132","name":"report-132","displayName":null,"description":null},{"id":"morning","name":"morning-brief","displayName":"Morning brief","description":"A daily overview"}]"#

private final class WorkflowCounter: Sendable { let value = Mutex(0) }
private final class WorkflowGate: Sendable {
  private struct State {
    var open = false
    var waiters: [CheckedContinuation<Void, Never>] = []
  }
  private let state = Mutex(State())
  func wait() async {
    await withCheckedContinuation { continuation in
      state.withLock {
        if $0.open { continuation.resume() } else { $0.waiters.append(continuation) }
      }
    }
  }
  func open() {
    let waiters = state.withLock { value in
      value.open = true
      let waiters = value.waiters
      value.waiters = []
      return waiters
    }
    for waiter in waiters { waiter.resume() }
  }
}
