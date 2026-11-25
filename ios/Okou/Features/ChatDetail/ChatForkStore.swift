import CCState
import ChatData
import ChatDomain
import Foundation

/// One sheet owns its input and delivery identity without changing the source conversation.
@MainActor
final class ChatForkStore: Identifiable {
  /// The send attempt: in flight, its failure, whether a captured message identity is pending,
  /// and whether its delivery is still unconfirmed.
  struct Attempt: Equatable {
    var isSending = false
    var error: String?
    var hasPendingAttempt = false
    var deliveryUnconfirmed = false
  }

  /// What the sheet shows besides the composer: the attempt, and the model settings in use.
  /// Those are the new chat's until the fork creates its thread, then that thread's.
  struct Presentation: Equatable {
    let attempt: Attempt
    let modelSelection: ChatModelSelectionStore

    static func == (lhs: Self, rhs: Self) -> Bool {
      lhs.attempt == rhs.attempt && lhs.modelSelection === rhs.modelSelection
    }
  }

  let id = UUID()

  let projectID: String?
  let composer: ComposerDraftStore
  let workflowSource: ComposerWorkflowSource
  let presentation: Computed<Presentation>
  /// The workspace session Store that keeps the fork's graph values.
  private let store: CCState.Store
  private let attempt = CCState.State(Attempt())
  private let modelSettings: CCState.State<ChatModelSelectionStore>
  private let sourceRunID: String
  private let sourceEventID: String
  private let commands: ChatCommands
  private let models: ChatModelStore
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
    let computerAccess: ChatComputerAccess
    let sourceRunID: String?
  }

  init(
    selection: ChatFeedbackSelection, sourceRunID: String, projectID: String?,
    commands: ChatCommands, graph: CCState.Store, models: ChatModelStore,
    workflowSource: ComposerWorkflowSource, lifecycleTasks: LifecycleTasks,
    didCreate: @escaping @MainActor (ChatThread) -> Void,
    didSend: @escaping @MainActor (ChatThread) -> Void,
    didFail: @escaping @MainActor (Error) -> Void
  ) {
    self.sourceRunID = sourceRunID
    sourceEventID = selection.eventID
    self.projectID = projectID
    self.commands = commands
    self.models = models
    self.lifecycleTasks = lifecycleTasks
    self.workflowSource = workflowSource
    self.didCreate = didCreate
    self.didSend = didSend
    self.didFail = didFail
    store = graph
    composer = ComposerDraftStore(
      target: .unassigned, commands: commands, graph: graph, didFail: didFail,
      lifecycleTasks: lifecycleTasks, preservesFeedbackNotes: true)
    let draftValue = composer.signals.value
    let uploadsValue = composer.attachments.value
    composerEdits = Computed { get in
      let draft = try get(draftValue)
      let uploads = try get(uploadsValue)
      return !draft.document.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        || uploads.hasAttachments
    }
    let modelSettings = CCState.State(
      ChatModelSelectionStore(models: models, lifecycleTasks: lifecycleTasks))
    self.modelSettings = modelSettings
    let attempt = attempt
    presentation = Computed { get in
      let current = try get(attempt)
      let modelSelection = try get(modelSettings)
      return Presentation(attempt: current, modelSelection: modelSelection)
    }
    composer.addFeedback(selection)
  }

  var modelSelection: ChatModelSelectionStore { snapshot(of: modelSettings) }
  var isSending: Bool { snapshot(of: attempt).isSending }
  var error: String? { snapshot(of: attempt).error }
  var hasPendingAttempt: Bool { snapshot(of: attempt).hasPendingAttempt }
  var deliveryUnconfirmed: Bool { snapshot(of: attempt).deliveryUnconfirmed }

  var hasSourceQuote: Bool {
    composer.document.parts.contains {
      $0["type"]?.string == "feedback" && $0["eventId"]?.string == sourceEventID
    }
  }

  /// Typed text or files in the fork's composer. The source quote alone is not an edit.
  let composerEdits: Computed<Bool>

  var hasEdits: Bool {
    guard !hasPendingAttempt else { return true }
    do { return try composer.store.get(composerEdits) } catch {
      preconditionFailure("Cannot read the fork composer graph: \(error)")
    }
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
        options: modelSelection.connectors.submissionOptions,
        computerAccess: modelSelection.connectors.computerAccess,
        sourceRunID: hasSourceQuote ? sourceRunID : nil)
    }
    guard let pending else { return false }
    update {
      $0.hasPendingAttempt = true
      $0.isSending = true
      $0.error = nil
    }
    modelSelection.isSending = true
    let task = Task<ChatThread?, Never> { [weak self] in
      guard let self else { return nil }
      defer {
        update { $0.isSending = false }
        modelSelection.isSending = false
        sendTask = nil
      }
      do {
        let workflows = try await workflowSource.prepareUse(
          in: pending.text, document: pending.document)
        try Task.checkCancellation()
        guard !closed else { return nil }
        let target: ChatThread
        if let thread {
          target = thread
        } else {
          target = try await commands.createThread(
            modelSelection: pending.model, reasoningEffort: pending.effort,
            composerOptions: pending.options, projectID: projectID, clientThreadID: clientThreadID)
          try Task.checkCancellation()
          guard !closed else { return nil }
          thread = target
          // Once created, settings belong to that thread, including edits after rejection.
          modelSelection.close()
          let settings = ChatModelSelectionStore(
            models: models, thread: target, lifecycleTasks: lifecycleTasks)
          settings.isSending = true
          write(modelSettings, settings)
          didCreate(target)
        }
        update { $0.deliveryUnconfirmed = true }
        _ = try await commands.send(
          thread: target, text: pending.text, attachments: pending.attachments,
          document: pending.document, clientEventID: pending.messageID,
          chatThreadSortEventID: pending.sortEventID,
          modelSelection: pending.model, reasoningEffort: pending.effort,
          computerAccess: pending.computerAccess,
          sourceRunID: pending.sourceRunID)
        try Task.checkCancellation()
        guard !closed else { return nil }
        update { $0.deliveryUnconfirmed = false }
        workflowSource.recordUse(workflows)
        return target
      } catch is CancellationError {
      } catch {
        guard !closed, !Task.isCancelled else { return nil }
        if let status = (error as? APIClientError)?.statusCode,
          (400..<500).contains(status), ![408, 409].contains(status)
        {
          // A definite rejection permits editing with a new message identity.
          update {
            $0.deliveryUnconfirmed = false
            $0.hasPendingAttempt = false
          }
          self.pending = nil
        }
        let message = ChatRequestFailure.message(for: error)
        update { $0.error = message }
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

  // The attempt and settings are synchronous in-process values; reads and writes cannot fail.
  private func snapshot<Value>(of signal: Signal<Value>) -> Value {
    do { return try store.get(signal) } catch {
      preconditionFailure("Cannot read the fork graph: \(error)")
    }
  }

  private func write<Value>(_ state: CCState.State<Value>, _ value: Value) {
    do { try store.set(state, value) } catch {
      preconditionFailure("Cannot update the fork graph: \(error)")
    }
  }

  private func update(_ mutation: (inout Attempt) -> Void) {
    var next = snapshot(of: attempt)
    mutation(&next)
    write(attempt, next)
  }

  isolated deinit { sendTask?.cancel() }
}
