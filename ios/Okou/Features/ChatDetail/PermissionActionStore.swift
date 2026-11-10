import CCState
import ChatData
import ChatDomain
import Foundation
import Observation

/// Stable permission resources live with their conversation, independently of reused rows and sheets.
@MainActor
final class PermissionActionRegistry {
  let store = CCState.Store()
  private let commands: ChatCommands
  private let sync: ChatSync
  private let didFail: @MainActor (Error) -> Void
  private let didContinue: @MainActor () async -> Void
  private var cards: [ChatPermissionAction: PermissionActionStore] = [:]
  private var batches: [ChatPermissionBatchAction: PermissionBatchStore] = [:]
  private var owner: UUID?
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

  var isBusy: Bool {
    cards.values.contains { $0.isSaving || $0.hasUnconfirmedOperation }
      || batches.values.contains { $0.isSaving || $0.hasUnconfirmedOperation }
  }

  func card(_ action: ChatPermissionBatchAction) -> PermissionBatchStore {
    if let existing = batches[action] { return existing }
    let resource =
      batches.values.first {
        $0.action.agentID.lowercased() == action.agentID.lowercased()
          && Set($0.action.items) == Set(action.items)
      }?.resource
      ?? PermissionReadResource(
        store: store, read: { [commands] in try await commands.batchPermissions.load(action) },
        didFail: didFail)
    let card = PermissionBatchStore(
      action: action, resource: resource, commands: commands, sync: sync,
      didFail: didFail, didContinue: didContinue)
    if closed {
      card.close()
    } else if owner != nil {
      card.activate()
    }
    batches[action] = card
    return card
  }

  func card(_ action: ChatPermissionAction) -> PermissionActionStore {
    if let existing = cards[action] { return existing }
    let resource =
      cards.values.first {
        $0.action.agentID.lowercased() == action.agentID.lowercased()
          && $0.action.connectorSlug == action.connectorSlug
      }?.resource
      ?? PermissionReadResource(
        store: store, read: { [commands] in try await commands.permissions.load(action) },
        didFail: didFail)
    let card = PermissionActionStore(
      action: action, resource: resource, commands: commands, sync: sync,
      didFail: didFail, didContinue: didContinue)
    if closed {
      card.close()
    } else if owner != nil {
      card.activate()
    }
    cards[action] = card
    return card
  }

  func activate(owner: UUID) {
    guard !closed, self.owner != owner else { return }
    if self.owner != nil { deactivate() }
    self.owner = owner
    for card in cards.values { card.activate() }
    for card in batches.values { card.activate() }
  }

  func deactivate() {
    owner = nil
    for card in cards.values { card.deactivate() }
    for card in batches.values { card.deactivate() }
  }
  func close() {
    closed = true
    for card in cards.values { card.close() }
    for card in batches.values { card.close() }
  }
}

@MainActor @Observable
final class PermissionActionStore {
  let action: ChatPermissionAction
  var duration: ChatPermissionAction.Duration
  let resource: PermissionReadResource<ChatPermissionSnapshot>
  private(set) var isActive = false
  private(set) var isSaving = false
  private(set) var error: String?
  private(set) var needsContinuation = false
  // Conversation eviction must not discard an uncertain write/continuation identity.
  private(set) var hasUnconfirmedOperation = false
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
    action: ChatPermissionAction, resource: PermissionReadResource<ChatPermissionSnapshot>,
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

  func canConfirm(_ snapshot: ChatPermissionSnapshot) -> Bool {
    !closed && isActive && !isSaving && snapshot.metadata?.contains(action.permission) == true
      && (!applied(snapshot) || needsContinuation)
  }

  func applied(_ snapshot: ChatPermissionSnapshot) -> Bool {
    snapshot.metadata?.policy(for: action.permission, grants: snapshot.grants, at: .now).rawValue
      == action.action.rawValue
  }

  func activate() {
    guard !closed else { return }
    isActive = true
    resource.activate()
  }

  func refresh() async {
    guard !closed, isActive, operation == nil, !Task.isCancelled else { return }
    let generation = generation
    resource.invalidate()
    if case .success(let current) = await readResult(), !closed, self.generation == generation {
      error = nil
      if !applied(current) { needsContinuation = false }
      if applied(current) && !needsContinuation { hasUnconfirmedOperation = false }
    }
  }

  /// Reads never retry a write or discard its conversation-lifetime continuation identity.
  private func readResult() async -> Result<ChatPermissionSnapshot, Error> {
    do { return .success(try await resource.load()) } catch { return .failure(error) }
  }

  func confirm() async {
    guard !closed, isActive, operation == nil, !Task.isCancelled else { return }
    let visit = generation
    guard case .success(let reviewed) = await readResult(),
      generation == visit, !Task.isCancelled, operation == nil, canConfirm(reviewed)
    else { return }
    isSaving = true
    error = nil
    let generation = generation
    let task = Task { [weak self] in
      guard let self else { return }
      defer {
        if self.generation == generation {
          isSaving = false
          operation = nil
          resource.invalidate()
        }
      }
      do {
        // Refresh before every explicit retry, including an ambiguous write response.
        try await commands.permissions.validateContext(action)
        let current = try await commands.permissions.load(action)
        try Task.checkCancellation()
        guard !closed, self.generation == generation else { return }
        guard current.metadata?.contains(action.permission) == true else {
          throw ChatError.invalidContract("This permission is no longer available.")
        }
        if !applied(current) {
          needsContinuation = action.callbackPrompt != nil
          hasUnconfirmedOperation = true
          _ = try await commands.permissions.apply(action, duration: duration)
          try Task.checkCancellation()
          guard !closed, self.generation == generation else { return }
        }
        // An already-applied request never resumes automatically after opening or refreshing.
        if needsContinuation, let prompt = action.callbackPrompt {
          try await commands.permissions.validateContext(action)
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
          needsContinuation = false
          await didContinue()
          try Task.checkCancellation()
          guard !closed, self.generation == generation else { return }
        }
        hasUnconfirmedOperation = false
      } catch is CancellationError {
      } catch {
        guard !closed, self.generation == generation else { return }
        self.error = ChatRequestFailure.message(for: error)
        didFail(error)
        // The resource reload in defer reads back without repeating the write or callback.
      }
    }
    operation = task
    await task.value
  }

  func deactivate() {
    isActive = false
    generation = UUID()
    resource.deactivate()
    operation?.cancel()
    operation = nil
    isSaving = false
  }

  func close() {
    closed = true
    deactivate()
    resource.close()
  }
}
