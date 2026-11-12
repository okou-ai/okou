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
  let resources: PermissionCardResources
  // These owners retain duration, confirmed review and exact mutation/continuation identities.
  // They are a business ledger until conversation close, not the disposable read cache.
  private var cards: [ChatPermissionAction: PermissionActionStore] = [:]
  private var batches: [ChatPermissionBatchAction: PermissionBatchStore] = [:]
  private var owner: UUID?
  private var closed = false

  init(
    commands: ChatCommands, sync: ChatSync, didFail: @escaping @MainActor (Error) -> Void,
    didContinue: @escaping @MainActor () async -> Void
  ) {
    self.commands = commands
    resources = PermissionCardResources(commands: commands, didFail: didFail)
    self.sync = sync
    self.didFail = didFail
    self.didContinue = didContinue
  }

  var isBusy: Bool {
    cards.values.contains { $0.isSaving } || batches.values.contains { $0.isSaving }
  }

  func card(_ action: ChatPermissionBatchAction) -> PermissionBatchStore {
    if let existing = batches[action] { return existing }
    let card = PermissionBatchStore(
      action: action, resources: resources, commands: commands, sync: sync, didFail: didFail,
      didContinue: didContinue)
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
    let card = PermissionActionStore(
      action: action, resources: resources, commands: commands, sync: sync,
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
    resources.activate()
    for card in cards.values { card.activate() }
    for card in batches.values { card.activate() }
  }

  func deactivate() {
    owner = nil
    resources.deactivate()
    for card in cards.values { card.deactivate() }
    for card in batches.values { card.deactivate() }
  }
  func close() {
    closed = true
    resources.close()
    for card in cards.values { card.close() }
    for card in batches.values { card.close() }
  }
}

@MainActor @Observable
final class PermissionActionStore {
  let action: ChatPermissionAction
  var duration: ChatPermissionAction.Duration
  // Confirmed review is used by explicit writes, independently of the UI read phase.
  private(set) var snapshot: ChatPermissionSnapshot?
  private(set) var isActive = false
  private(set) var isSaving = false
  // Only mutation/continuation failures live here; read failures stay in their Task.
  private(set) var error: String?
  private(set) var needsContinuation = false
  private let commands: ChatCommands
  private let sync: ChatSync
  private let didFail: @MainActor (Error) -> Void
  private let didContinue: @MainActor () async -> Void
  private let clientEventID = UUID().uuidString.lowercased()
  private let sortEventID = UUID().uuidString.lowercased()
  private var operation: Task<Void, Never>?
  private let resources: PermissionCardResources
  private var generation = UUID()
  private var closed = false

  init(
    action: ChatPermissionAction, resources: PermissionCardResources, commands: ChatCommands,
    sync: ChatSync,
    didFail: @escaping @MainActor (Error) -> Void,
    didContinue: @escaping @MainActor () async -> Void
  ) {
    self.action = action
    self.resources = resources
    duration = action.duration
    self.commands = commands
    self.sync = sync
    self.didFail = didFail
    self.didContinue = didContinue
  }

  var read: PermissionCardRead<ChatPermissionSnapshot> { resources.read(action) }
  private var review: PermissionActionReview {
    PermissionActionReview(action: action, snapshot: snapshot)
  }
  var metadata: ChatPermissionMetadata? { review.metadata }
  var hasPermission: Bool { review.hasPermission }
  var applied: Bool { review.applied }
  var grant: ChatPermissionRule? { review.grant }
  var canConfirm: Bool { canConfirm(reviewing: snapshot) }

  func canConfirm(reviewing snapshot: ChatPermissionSnapshot?) -> Bool {
    let review = PermissionActionReview(action: action, snapshot: snapshot)
    return !closed && isActive && !isSaving && review.hasPermission
      && (!review.applied || needsContinuation)
  }

  func activate() {
    guard !closed else { return }
    isActive = true
  }

  func loadIfNeeded() async { await load(refresh: false) }
  func refresh() async { await load(refresh: true) }

  private func load(refresh: Bool) async {
    guard !closed, isActive, operation == nil, !Task.isCancelled else { return }
    let generation = generation
    do {
      let value = try await read.load(refresh: refresh)
      try Task.checkCancellation()
      guard !closed, isActive, operation == nil, self.generation == generation else { return }
      snapshot = value
      if refresh { error = nil }
      if !applied { needsContinuation = false }
    } catch is CancellationError {
    } catch {
      guard !closed, isActive, operation == nil, self.generation == generation else { return }
      snapshot = nil
    }
  }

  func confirm(reviewing reviewed: ChatPermissionSnapshot? = nil) async {
    let reviewed = reviewed ?? snapshot
    guard canConfirm(reviewing: reviewed), operation == nil, !Task.isCancelled else { return }
    let continuing =
      needsContinuation && PermissionActionReview(action: action, snapshot: reviewed).applied
    isSaving = true
    error = nil
    generation = UUID()
    let generation = generation
    let read = read
    let task = Task { [weak self, read] in
      guard let self else { return }
      defer {
        if self.generation == generation {
          isSaving = false
          operation = nil
          read.invalidate()
        }
      }
      do {
        // The command consumes the same original Task the visible card reviewed.
        let cached = try await read.load()
        try Task.checkCancellation()
        guard !closed, self.generation == generation else { return }
        guard PermissionActionReview(action: action, snapshot: cached).hasPermission else {
          throw ChatError.invalidContract("This permission is no longer available.")
        }
        // Refresh before every explicit retry, including an ambiguous write response.
        try await commands.permissions.validateContext(action)
        let current = try await commands.permissions.load(action)
        try Task.checkCancellation()
        guard !closed, self.generation == generation else { return }
        snapshot = current
        guard hasPermission else {
          throw ChatError.invalidContract("This permission is no longer available.")
        }
        if continuing && !applied {
          throw ChatError.invalidContract("The permission changed. Review the request again.")
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
        self.error = ChatRequestFailure.message(for: error)
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
    isActive = false
    generation = UUID()
    operation?.cancel()
    operation = nil
    isSaving = false
  }

  func close() {
    closed = true
    deactivate()
  }
}

/// The same semantic review is used by explicit operations and original-Task UI projections.
struct PermissionActionReview {
  let action: ChatPermissionAction
  let snapshot: ChatPermissionSnapshot?
  var metadata: ChatPermissionMetadata? { snapshot?.metadata }
  var hasPermission: Bool { metadata?.contains(action.permission) == true }
  var applied: Bool {
    guard let snapshot, let metadata else { return false }
    return metadata.policy(for: action.permission, grants: snapshot.grants, at: .now).rawValue
      == action.action.rawValue
  }
  var grant: ChatPermissionRule? {
    snapshot?.grants.last {
      $0.connectorSlug == action.connectorSlug && $0.permission == action.permission
        && $0.action == action.action
    }
  }
}
