import ChatData
import ChatDomain
import Foundation
import Observation

/// Stable permission resources live with their conversation, independently of reused rows and sheets.
@MainActor
final class PermissionActionRegistry {
  private let commands: ChatCommands
  private let sync: ChatSync
  private let didFail: @MainActor (Error) -> Void
  private let didContinue: @MainActor () async -> Void
  private var cards: [ChatPermissionAction: PermissionActionStore] = [:]
  private var closed = false

  init(
    commands: ChatCommands, sync: ChatSync, didFail: @escaping @MainActor (Error) -> Void,
    didContinue: @escaping @MainActor () async -> Void
  ) {
    self.commands = commands
    self.sync = sync
    self.didFail = didFail
    self.didContinue = didContinue
  }

  var isBusy: Bool { cards.values.contains { $0.isSaving } }

  func card(_ action: ChatPermissionAction) -> PermissionActionStore {
    if let existing = cards[action] { return existing }
    let card = PermissionActionStore(
      action: action, commands: commands, sync: sync,
      didFail: didFail, didContinue: didContinue)
    if closed { card.close() }
    cards[action] = card
    return card
  }

  func refresh() async { for card in cards.values { await card.refresh() } }
  func deactivate() { for card in cards.values { card.deactivate() } }
  func close() {
    closed = true
    for card in cards.values { card.close() }
  }
}

@MainActor @Observable
final class PermissionActionStore {
  let action: ChatPermissionAction
  var duration: ChatPermissionAction.Duration
  private(set) var snapshot: ChatPermissionSnapshot?
  private(set) var isLoading = false
  private(set) var isSaving = false
  private(set) var error: String?
  private(set) var needsContinuation = false
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
    action: ChatPermissionAction, commands: ChatCommands, sync: ChatSync,
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

  var metadata: ChatPermissionMetadata? { snapshot?.metadata }
  var hasPermission: Bool { metadata?.contains(action.permission) == true }
  var applied: Bool {
    guard let snapshot, let metadata else { return false }
    return metadata.policy(for: action.permission, grants: snapshot.grants, at: .now).rawValue
      == action.action.rawValue
  }
  var grant: ChatPermissionGrant? {
    snapshot?.grants.last {
      $0.connectorSlug == action.connectorSlug && $0.permission == action.permission
        && $0.action == action.action
    }
  }
  var canConfirm: Bool {
    !closed && !isLoading && !isSaving && hasPermission && (!applied || needsContinuation)
  }

  func refresh() async {
    guard !closed, operation == nil, !isLoading, !Task.isCancelled else { return }
    isLoading = true
    let generation = generation
    defer { if self.generation == generation { isLoading = false } }
    do {
      let value = try await commands.permissions.load(action)
      try Task.checkCancellation()
      guard !closed, self.generation == generation else { return }
      snapshot = value
      error = nil
      if !applied { needsContinuation = false }
    } catch is CancellationError {
    } catch {
      guard !closed, self.generation == generation else { return }
      snapshot = nil
      self.error = error.localizedDescription
      didFail(error)
    }
  }

  func confirm() async {
    guard canConfirm, operation == nil, !Task.isCancelled else { return }
    isSaving = true
    error = nil
    let generation = generation
    let task = Task { [weak self] in
      guard let self else { return }
      defer {
        if self.generation == generation {
          isSaving = false
          operation = nil
        }
      }
      do {
        // Refresh before every explicit retry, including an ambiguous write response.
        let current = try await commands.permissions.load(action)
        try Task.checkCancellation()
        guard !closed, self.generation == generation else { return }
        snapshot = current
        guard hasPermission else {
          throw ChatError.invalidContract("This permission is no longer available.")
        }
        if !applied {
          needsContinuation = action.callbackPrompt != nil
          _ = try await commands.permissions.apply(action, duration: duration)
        }
        // An already-applied request never resumes automatically after opening or refreshing.
        if needsContinuation, let prompt = action.callbackPrompt {
          try await commands.permissions.validateContext(action)
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
          needsContinuation = false
          await didContinue()
        }
        let updated = try await commands.permissions.load(action)
        try Task.checkCancellation()
        guard !closed, self.generation == generation else { return }
        snapshot = updated
      } catch is CancellationError {
      } catch {
        guard !closed, self.generation == generation else { return }
        self.error = error.localizedDescription
        didFail(error)
        // Read back an uncertain write without repeating it or sending a callback.
        if let updated = try? await commands.permissions.load(action),
          !closed, self.generation == generation
        {
          snapshot = updated
        }
      }
    }
    operation = task
    await task.value
  }

  func deactivate() {
    generation = UUID()
    operation?.cancel()
    operation = nil
    isLoading = false
    isSaving = false
  }

  func close() {
    closed = true
    deactivate()
  }
}
