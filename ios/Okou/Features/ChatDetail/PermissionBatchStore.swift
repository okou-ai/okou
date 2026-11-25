import CCState
import ChatData
import ChatDomain
import Foundation

@MainActor
final class PermissionBatchStore {
  /// The card's state besides its read phase, kept in the workspace session graph.
  struct Presentation: Equatable {
    var isActive = false
    /// Counts activations. Each activation asks the row to load the review again.
    var activation = 0
    var duration: ChatPermissionAction.Duration
    /// The reviewed list and uncertain-write reconciliation survive read cache eviction.
    var snapshot: ChatPermissionBatchSnapshot?
    /// Changes with every reviewed list, which is not itself comparable.
    var snapshotRevision = 0
    var isBusy = false
    var isSaving = false
    var isContinuing = false
    var hasContinued = false
    var requiresReadback = false
    /// Read errors remain in the original Task; this is an explicit-operation failure.
    var error: String?

    static func == (lhs: Self, rhs: Self) -> Bool {
      lhs.isActive == rhs.isActive && lhs.activation == rhs.activation
        && lhs.duration == rhs.duration && lhs.snapshotRevision == rhs.snapshotRevision
        && lhs.isBusy == rhs.isBusy && lhs.isSaving == rhs.isSaving
        && lhs.isContinuing == rhs.isContinuing && lhs.hasContinued == rhs.hasContinued
        && lhs.requiresReadback == rhs.requiresReadback && lhs.error == rhs.error
    }

    func displayedSnapshot(_ loaded: ChatPermissionBatchSnapshot?)
      -> ChatPermissionBatchSnapshot?
    {
      if isBusy { return snapshot }
      return loaded ?? snapshot
    }

    func canConfirm(
      _ action: ChatPermissionBatchAction, reviewing snapshot: ChatPermissionBatchSnapshot?
    ) -> Bool {
      let allAllowed = snapshot?.allAllowed == true && !requiresReadback
      let needsContinuation = allAllowed && action.callbackPrompt != nil && !hasContinued
      return isActive && !isBusy && !requiresReadback && snapshot?.complete == true
        && (!allAllowed || needsContinuation)
    }
  }

  let action: ChatPermissionBatchAction
  let presentation: Computed<Presentation>
  /// The workspace session Store that keeps this card's graph values.
  private let store: CCState.Store
  private let model: CCState.State<Presentation>
  private let commands: ChatCommands
  private let sync: ChatSync
  private let didFail: @MainActor (Error) -> Void
  private let didContinue: @MainActor () async -> Void
  private let clientEventID = UUID().uuidString.lowercased()
  private let sortEventID = UUID().uuidString.lowercased()
  private var operation: Task<Void, Never>?
  private var continuationUncertain = false
  private let resources: PermissionCardResources
  private var generation = UUID()
  private var closed = false

  init(
    action: ChatPermissionBatchAction, resources: PermissionCardResources, commands: ChatCommands,
    sync: ChatSync, graph: CCState.Store,
    didFail: @escaping @MainActor (Error) -> Void,
    didContinue: @escaping @MainActor () async -> Void
  ) {
    self.action = action
    self.resources = resources
    self.commands = commands
    self.sync = sync
    self.didFail = didFail
    self.didContinue = didContinue
    store = graph
    let model = CCState.State(Presentation(duration: action.duration))
    self.model = model
    presentation = Computed { get in try get(model) }
  }

  var read: PermissionCardRead<ChatPermissionBatchSnapshot> { resources.read(action) }
  private var current: Presentation {
    do { return try store.get(model) } catch {
      preconditionFailure("Cannot read the permission batch graph: \(error)")
    }
  }
  var duration: ChatPermissionAction.Duration {
    get { current.duration }
    set { update { $0.duration = newValue } }
  }
  var snapshot: ChatPermissionBatchSnapshot? { current.snapshot }
  var isActive: Bool { current.isActive }
  var isSaving: Bool { current.isSaving }
  var isContinuing: Bool { current.isContinuing }
  var hasContinued: Bool { current.hasContinued }
  var requiresReadback: Bool { current.requiresReadback }
  var error: String? { current.error }
  var allAllowed: Bool { snapshot?.allAllowed == true && !requiresReadback }
  var needsContinuation: Bool { allAllowed && action.callbackPrompt != nil && !hasContinued }
  var canConfirm: Bool { canConfirm(reviewing: snapshot) }

  func displayedSnapshot(_ loaded: ChatPermissionBatchSnapshot?) -> ChatPermissionBatchSnapshot? {
    current.displayedSnapshot(loaded)
  }

  func canConfirm(reviewing snapshot: ChatPermissionBatchSnapshot?) -> Bool {
    !closed && operation == nil && current.canConfirm(action, reviewing: snapshot)
  }

  func activate() {
    guard !closed else { return }
    update {
      guard !$0.isActive else { return }
      $0.isActive = true
      $0.activation += 1
    }
  }

  func loadIfNeeded() async { await load(refresh: false) }
  func refresh() async { await load(refresh: true) }

  private func load(refresh: Bool) async {
    guard !closed, isActive, operation == nil, !Task.isCancelled else { return }
    let generation = generation
    do {
      let loaded = try await read.load(refresh: refresh)
      try Task.checkCancellation()
      guard !closed, isActive, operation == nil, self.generation == generation else { return }
      update {
        $0.snapshot = loaded
        $0.snapshotRevision += 1
        $0.requiresReadback = false
        if refresh { $0.error = nil }
      }
    } catch is CancellationError {
    } catch {
      guard !closed, isActive, operation == nil, self.generation == generation else { return }
      update { $0.requiresReadback = true }
    }
  }

  func confirm(reviewing reviewed: ChatPermissionBatchSnapshot? = nil) async {
    guard let reviewed = reviewed ?? snapshot, canConfirm(reviewing: reviewed), operation == nil,
      !Task.isCancelled
    else { return }
    record(reviewed) {
      $0.isBusy = true
      $0.isSaving = !reviewed.allAllowed
      $0.isContinuing = reviewed.allAllowed
      $0.error = nil
    }
    generation = UUID()
    let generation = generation
    let read = read
    let task = Task { [weak self, read] in
      guard let self else { return }
      defer {
        if self.generation == generation {
          finishAttempt()
          operation = nil
          read.invalidate()
        }
      }
      do {
        // Cache identity is shared, but write and continuation identities remain with this owner.
        let cached = try await read.load()
        try Task.checkCancellation()
        guard !closed, self.generation == generation else { return }
        guard cached.complete else {
          throw ChatError.invalidContract("These permissions are no longer available.")
        }
        let verified: ChatPermissionBatchSnapshot
        if reviewed.allAllowed {
          // "Continue chat" never silently re-grants a permission revoked after review.
          try await commands.batchPermissions.validateContext(action)
          let current = try await commands.batchPermissions.load(action)
          guard current.allAllowed else {
            throw ChatError.invalidContract("Some permissions are no longer allowed. Review again.")
          }
          verified = current
        } else {
          verified = try await commands.batchPermissions.apply(
            action, duration: duration, reviewing: reviewed)
        }
        try Task.checkCancellation()
        guard !closed, self.generation == generation else { return }
        record(verified) { $0.isSaving = false }
        if needsContinuation, let prompt = action.callbackPrompt {
          update { $0.isContinuing = true }
          var delivered = false
          if continuationUncertain {
            try await commands.batchPermissions.validateContext(action)
            let history = try await sync.eventHistory(threadID: action.threadID)
            try Task.checkCancellation()
            guard !closed, self.generation == generation else { return }
            delivered = history.persistedEventIDs.contains(clientEventID)
          }
          if !delivered {
            let thread = ChatThread(
              id: action.threadID, title: "", createdAt: .now,
              updatedAt: .now, sortAt: .now, pinnedAt: nil, pinOrder: nil)
            continuationUncertain = true
            _ = try await commands.send(
              thread: thread, text: prompt, clientEventID: clientEventID,
              chatThreadSortEventID: sortEventID)
          }
          try Task.checkCancellation()
          guard !closed, self.generation == generation else { return }
          continuationUncertain = false
          update {
            $0.hasContinued = true
            $0.isContinuing = false
          }
          await didContinue()
        }
      } catch is CancellationError {
      } catch {
        guard !closed, self.generation == generation else { return }
        let message = ChatRequestFailure.message(for: error)
        update {
          $0.error = message
          $0.requiresReadback = true
        }
        didFail(error)
        // A lost response or partial connector save cannot be blindly repeated.
        do {
          let readback = try await commands.batchPermissions.load(action)
          try Task.checkCancellation()
          guard !closed, self.generation == generation else { return }
          record(readback) { $0.requiresReadback = false }
        } catch is CancellationError {
        } catch {
          // Keep the reviewed list, but require a successful read before another write.
          guard !closed, self.generation == generation else { return }
          let message = ChatRequestFailure.message(for: error)
          update { $0.error = message }
          didFail(error)
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
    update {
      $0.isActive = false
      if $0.isSaving || $0.isContinuing { $0.requiresReadback = true }
      $0.isBusy = false
      $0.isSaving = false
      $0.isContinuing = false
    }
  }

  func close() {
    closed = true
    deactivate()
  }

  /// Records a reviewed or confirmed list together with the rest of the same transition.
  private func record(
    _ snapshot: ChatPermissionBatchSnapshot, _ mutation: (inout Presentation) -> Void = { _ in }
  ) {
    update {
      $0.snapshot = snapshot
      $0.snapshotRevision += 1
      mutation(&$0)
    }
  }

  private func finishAttempt() {
    update {
      $0.isBusy = false
      $0.isSaving = false
      $0.isContinuing = false
    }
  }

  // The card's state is a synchronous in-process value; replacing it cannot fail.
  private func update(_ mutation: (inout Presentation) -> Void) {
    var next = current
    mutation(&next)
    do { try store.set(model, next) } catch {
      preconditionFailure("Cannot update the permission batch graph: \(error)")
    }
  }
}
