import ChatData
import ChatDomain
import Foundation
import Observation

@MainActor @Observable
final class PermissionBatchStore {
  let action: ChatPermissionBatchAction
  var duration: ChatPermissionAction.Duration
  let resource: PermissionReadResource<ChatPermissionBatchSnapshot>
  /// A partial/uncertain save's reviewed list, retained only until successful readback.
  private(set) var unconfirmedSnapshot: ChatPermissionBatchSnapshot?
  private(set) var isActive = false
  private(set) var isSaving = false
  private(set) var isContinuing = false
  private(set) var hasContinued = false
  private(set) var requiresReadback = false
  private(set) var hasUnconfirmedOperation = false
  private(set) var error: String?
  private let commands: ChatCommands
  private let sync: ChatSync
  private let didFail: @MainActor (Error) -> Void
  private let didContinue: @MainActor () async -> Void
  private let clientEventID = UUID().uuidString.lowercased()
  private let sortEventID = UUID().uuidString.lowercased()
  private var operation: Task<Void, Never>?
  private var generation = UUID()
  private var closed = false

  init(
    action: ChatPermissionBatchAction,
    resource: PermissionReadResource<ChatPermissionBatchSnapshot>,
    commands: ChatCommands, sync: ChatSync,
    didFail: @escaping @MainActor (Error) -> Void,
    didContinue: @escaping @MainActor () async -> Void
  ) {
    self.action = action
    self.resource = resource
    duration = action.duration
    self.commands = commands
    self.sync = sync
    self.didFail = didFail
    self.didContinue = didContinue
  }

  func needsContinuation(_ snapshot: ChatPermissionBatchSnapshot) -> Bool {
    snapshot.allAllowed && action.callbackPrompt != nil && !hasContinued
  }

  func canConfirm(_ snapshot: ChatPermissionBatchSnapshot) -> Bool {
    !closed && isActive && !isSaving && !requiresReadback && snapshot.complete
      && (!snapshot.allAllowed || needsContinuation(snapshot))
  }

  func activate() {
    guard !closed else { return }
    isActive = true
    resource.activate()
  }

  func refresh() async {
    guard !closed, isActive, operation == nil, !Task.isCancelled else { return }
    resource.invalidate()
    let generation = generation
    do {
      let current = try await resource.load()
      try Task.checkCancellation()
      guard !closed, self.generation == generation else { return }
      requiresReadback = false
      unconfirmedSnapshot = nil
      if current.allAllowed && !needsContinuation(current) { hasUnconfirmedOperation = false }
      error = nil
    } catch {
      // The original resource Task owns read errors and their authentication/upgrade handling.
    }
  }

  func confirm(_ reviewed: ChatPermissionBatchSnapshot) async {
    guard canConfirm(reviewed), operation == nil, !Task.isCancelled else { return }
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
          resource.invalidate()
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
          hasUnconfirmedOperation = true
          verified = try await commands.batchPermissions.apply(
            action, duration: duration, expectedConnectorScoped: reviewed.connectorScoped)
        }
        try Task.checkCancellation()
        guard !closed, self.generation == generation else { return }
        unconfirmedSnapshot = verified
        if needsContinuation(verified), let prompt = action.callbackPrompt {
          isContinuing = true
          hasUnconfirmedOperation = true
          try await commands.batchPermissions.validateContext(action)
          let history = try await sync.history(threadID: action.threadID)
          try Task.checkCancellation()
          guard !closed, self.generation == generation else { return }
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
          try Task.checkCancellation()
          guard !closed, self.generation == generation else { return }
        }
        unconfirmedSnapshot = nil
        hasUnconfirmedOperation = false
      } catch is CancellationError {
      } catch {
        guard !closed, self.generation == generation else { return }
        self.error = ChatRequestFailure.message(for: error)
        requiresReadback = true
        unconfirmedSnapshot = unconfirmedSnapshot ?? reviewed
        didFail(error)
        // A lost response or partial connector save cannot be blindly repeated.
        do {
          let current = try await commands.batchPermissions.load(action)
          try Task.checkCancellation()
          guard !closed, self.generation == generation else { return }
          unconfirmedSnapshot = current
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
    if isSaving { requiresReadback = true }
    generation = UUID()
    resource.deactivate()
    operation?.cancel()
    operation = nil
    isSaving = false
    isContinuing = false
  }

  func close() {
    closed = true
    deactivate()
    resource.close()
  }
}
