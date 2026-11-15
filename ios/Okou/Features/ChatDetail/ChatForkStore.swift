import ChatData
import ChatDomain
import Foundation
import Observation

/// One sheet owns its input and delivery identity without changing the source conversation.
@MainActor @Observable
final class ChatForkStore: Identifiable {
  let id = UUID()
  let sourceTitle: String
  let agentID: String
  let composer: ComposerDraftStore
  let modelSelection: ChatModelSelectionStore
  let workflowSource: ComposerWorkflowSource
  private(set) var isSending = false
  private(set) var error: String?
  private(set) var hasPendingAttempt = false
  private let sourceRunID: String
  private let sourceEventID: String
  private let commands: ChatCommands
  private let lifecycleTasks: LifecycleTasks
  private let didCreate: @MainActor (ChatThread) -> Void
  private let didSend: @MainActor (ChatThread) -> Void
  private let didFail: @MainActor (Error) -> Void
  private let clientThreadID = UUID().uuidString.lowercased()
  private var thread: ChatThread?
  private var pending: Submission?
  private var sendTask: Task<ChatThread?, Never>?
  private var closed = false

  private struct Submission {
    let messageID = UUID().uuidString.lowercased()
    let sortEventID = UUID().uuidString.lowercased()
    let text: String
    let document: ChatDraftDocument?
    let attachments: [ChatAttachment]
    let model: ChatModelSelection?
    let effort: String?
    let options: ChatComposerOptions
    let sourceRunID: String?
  }

  init(
    selection: ChatFeedbackSelection, sourceRunID: String, sourceTitle: String,
    agentID: String, commands: ChatCommands, models: ChatModelStore,
    workflowSource: ComposerWorkflowSource, lifecycleTasks: LifecycleTasks,
    didCreate: @escaping @MainActor (ChatThread) -> Void,
    didSend: @escaping @MainActor (ChatThread) -> Void,
    didFail: @escaping @MainActor (Error) -> Void
  ) {
    self.sourceTitle = sourceTitle
    self.sourceRunID = sourceRunID
    sourceEventID = selection.eventID
    self.agentID = agentID
    self.commands = commands
    self.lifecycleTasks = lifecycleTasks
    self.workflowSource = workflowSource
    self.didCreate = didCreate
    self.didSend = didSend
    self.didFail = didFail
    composer = ComposerDraftStore(
      target: .unassigned, commands: commands, didFail: didFail,
      lifecycleTasks: lifecycleTasks, preservesFeedbackNotes: true)
    modelSelection = ChatModelSelectionStore(models: models, lifecycleTasks: lifecycleTasks)
    modelSelection.connectors.configure(agentID: agentID)
    composer.addFeedback(selection)
  }

  var hasSourceQuote: Bool {
    composer.document.parts.contains {
      $0["type"]?.string == "feedback" && $0["eventId"]?.string == sourceEventID
    }
  }

  var hasEdits: Bool {
    hasPendingAttempt || !composer.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      || composer.attachments.hasAttachments
  }

  @discardableResult
  func send() async -> Bool {
    guard !closed, sendTask == nil, !Task.isCancelled else { return false }
    if pending == nil {
      guard composer.hasContent, composer.canSend, composer.attachments.isReady,
        modelSelection.canSend
      else { return false }
      // Ending native editing commits marked text before capturing the immutable attempt.
      composer.editor.dismissKeyboard()
      pending = Submission(
        text: composer.text.trimmingCharacters(in: .whitespacesAndNewlines),
        document: composer.value.draftUserMessage?.trimmingWhitespace(),
        attachments: composer.attachments.uploaded,
        model: modelSelection.models.configuration.map { _ in
          modelSelection.captureNewChatSelection()
        }, effort: modelSelection.requestedEffort,
        options: modelSelection.connectors.pendingOptions,
        sourceRunID: hasSourceQuote ? sourceRunID : nil)
    }
    guard let pending else { return false }
    hasPendingAttempt = true
    isSending = true
    modelSelection.isSending = true
    error = nil
    let task = Task<ChatThread?, Never> { [weak self] in
      guard let self else { return nil }
      defer {
        isSending = false
        modelSelection.isSending = false
        sendTask = nil
      }
      do {
        let workflows = try await workflowSource.prepareUse(
          in: pending.text, document: pending.document, agentID: agentID)
        try Task.checkCancellation()
        guard !closed else { return nil }
        let target: ChatThread
        if let thread {
          target = thread
        } else {
          target = try await commands.createThread(
            modelSelection: pending.model, reasoningEffort: pending.effort,
            composerOptions: pending.options, clientThreadID: clientThreadID)
          try Task.checkCancellation()
          guard !closed else { return nil }
          thread = target
          didCreate(target)
        }
        _ = try await commands.send(
          thread: target, text: pending.text, attachments: pending.attachments,
          document: pending.document, clientEventID: pending.messageID,
          chatThreadSortEventID: pending.sortEventID,
          modelSelection: pending.model, reasoningEffort: pending.effort,
          computerAccess: pending.options.computerAccess,
          expectedAgentID: agentID, sourceRunID: pending.sourceRunID)
        try Task.checkCancellation()
        guard !closed else { return nil }
        workflowSource.recordUse(workflows)
        return target
      } catch is CancellationError {
      } catch {
        guard !closed, !Task.isCancelled else { return nil }
        self.error = ChatRequestFailure.message(for: error)
        didFail(error)
      }
      return nil
    }
    sendTask = task
    lifecycleTasks.track(task)
    guard let accepted = await task.value, !closed, !Task.isCancelled else { return false }
    composer.clear()
    didSend(accepted)
    return true
  }

  func close() {
    guard !closed else { return }
    closed = true
    sendTask?.cancel()
    composer.close()
    modelSelection.close()
  }

  isolated deinit { sendTask?.cancel() }
}
