import ChatData
import ChatDomain
import Foundation
import Observation

@MainActor @Observable
final class PermissionBatchStore {
  let action: ChatPermissionBatchAction
  var duration: ChatPermissionAction.Duration
  private(set) var snapshot: ChatPermissionBatchSnapshot?
  private(set) var isActive = false
  private(set) var isLoading = false
  private(set) var isSaving = false
  private(set) var isContinuing = false
  private(set) var hasContinued = false
  private(set) var requiresReadback = false
  private(set) var error: String?
  private let commands: ChatCommands
  private let sync: ChatSync
  private let didFail: @MainActor (Error) -> Void
  private let didContinue: @MainActor () async -> Void
  private let clientEventID = UUID().uuidString.lowercased()
  private let sortEventID = UUID().uuidString.lowercased()
  private var operation: Task<Void, Never>?
  private var read: Task<Void, Never>?
  private var requested = false
  private var generation = UUID()
  private var closed = false

  init(
    action: ChatPermissionBatchAction, commands: ChatCommands, sync: ChatSync,
    didFail: @escaping @MainActor (Error) -> Void,
    didContinue: @escaping @MainActor () async -> Void
  ) {
    self.action = action
    duration = action.duration
    self.commands = commands
    self.sync = sync
    self.didFail = didFail
    self.didContinue = didContinue
  }

  var allAllowed: Bool { snapshot?.allAllowed == true && !requiresReadback }
  var needsContinuation: Bool { allAllowed && action.callbackPrompt != nil && !hasContinued }
  var canConfirm: Bool {
    !closed && !isLoading && !isSaving && !requiresReadback && snapshot?.complete == true
      && (!allAllowed || needsContinuation)
  }

  func activate() {
    guard !closed else { return }
    isActive = true
  }

  func loadIfNeeded() async {
    guard !closed, isActive, !requested, !Task.isCancelled else { return }
    requested = true
    await refresh()
  }

  func refresh() async {
    guard !closed, operation == nil, !Task.isCancelled else { return }
    if let read {
      await read.value
      return
    }
    isLoading = true
    let generation = generation
    let task = Task { [weak self] in
      guard let self else { return }
      defer {
        if self.generation == generation {
          isLoading = false
          read = nil
        }
      }
      do {
        let current = try await commands.batchPermissions.load(action)
        try Task.checkCancellation()
        guard !closed, self.generation == generation else { return }
        snapshot = current
        requiresReadback = false
        error = nil
      } catch is CancellationError {
      } catch {
        guard !closed, self.generation == generation else { return }
        requiresReadback = true
        self.error = ChatRequestFailure.message(for: error)
        didFail(error)
      }
    }
    read = task
    await task.value
  }

  func confirm() async {
    guard canConfirm, let reviewed = snapshot, operation == nil, !Task.isCancelled else { return }
    isSaving = true
    isContinuing = reviewed.allAllowed && action.callbackPrompt != nil && !hasContinued
    error = nil
    let generation = generation
    let task = Task { [weak self] in
      guard let self else { return }
      defer {
        if self.generation == generation {
          isSaving = false
          isContinuing = false
          operation = nil
        }
      }
      do {
        let verified: ChatPermissionBatchSnapshot
        if reviewed.allAllowed {
          // "Continue chat" never silently re-grants a permission revoked after review.
          try await commands.batchPermissions.validateContext(action)
          let current = try await commands.batchPermissions.load(action)
          guard current.connectorScoped == reviewed.connectorScoped else {
            throw ChatError.invalidContract("Permission scope changed. Review the request again.")
          }
          guard current.allAllowed else {
            throw ChatError.invalidContract("Some permissions are no longer allowed. Review again.")
          }
          verified = current
        } else {
          // The service verifies the current scope and grants, then reads back the save.
          verified = try await commands.batchPermissions.apply(
            action, duration: duration, expectedConnectorScoped: reviewed.connectorScoped)
        }
        try Task.checkCancellation()
        guard !closed, self.generation == generation else { return }
        snapshot = verified
        if needsContinuation, let prompt = action.callbackPrompt {
          isContinuing = true
          try await commands.batchPermissions.validateContext(action)
          let history = try await sync.history(threadID: action.threadID)
          if !history.persistedEventIDs.contains(clientEventID) {
            let thread = ChatThread(
              id: action.threadID, agentID: action.agentID, title: "", createdAt: .now,
              updatedAt: .now, sortAt: .now, pinnedAt: nil, pinOrder: nil)
            _ = try await commands.send(
              thread: thread, text: prompt, clientEventID: clientEventID,
              chatThreadSortEventID: sortEventID, expectedAgentID: action.agentID)
          }
          try Task.checkCancellation()
          guard !closed, self.generation == generation else { return }
          hasContinued = true
          await didContinue()
        }
      } catch is CancellationError {
      } catch {
        guard !closed, self.generation == generation else { return }
        self.error = ChatRequestFailure.message(for: error)
        requiresReadback = true
        didFail(error)
        // A lost response or partial connector save cannot be blindly repeated.
        do {
          let current = try await commands.batchPermissions.load(action)
          try Task.checkCancellation()
          guard !closed, self.generation == generation else { return }
          snapshot = current
          requiresReadback = false
        } catch is CancellationError {
        } catch {
          // Keep the reviewed list, but require a successful read before another write.
          guard !closed, self.generation == generation else { return }
          self.error = ChatRequestFailure.message(for: error)
          didFail(error)
        }
      }
    }
    operation = task
    await task.value
  }

  func deactivate() {
    isActive = false
    requested = false
    if isSaving { requiresReadback = true }
    generation = UUID()
    read?.cancel()
    read = nil
    operation?.cancel()
    operation = nil
    isLoading = false
    isSaving = false
    isContinuing = false
  }

  func close() {
    closed = true
    deactivate()
  }
}
