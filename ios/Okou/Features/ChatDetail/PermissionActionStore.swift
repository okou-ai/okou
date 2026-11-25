import CCState
import ChatData
import ChatDomain
import Foundation

@MainActor
final class PermissionActionStore {
  /// The card's state besides its read phase, kept in the workspace session graph.
  struct Presentation: Equatable {
    var isActive = false
    /// Counts activations. Each activation asks the row to load the review again.
    var activation = 0
    var duration: ChatPermissionAction.Duration
    /// The confirmed review used by explicit writes, independently of the UI read phase.
    var snapshot: ChatPermissionSnapshot?
    /// Changes with every confirmed review, which is not itself comparable.
    var snapshotRevision = 0
    var isBusy = false
    var isSaving = false
    var isContinuing = false
    /// Only mutation/continuation failures live here; read failures stay in their Task.
    var error: String?
    var needsContinuation = false

    static func == (lhs: Self, rhs: Self) -> Bool {
      lhs.isActive == rhs.isActive && lhs.activation == rhs.activation
        && lhs.duration == rhs.duration && lhs.snapshotRevision == rhs.snapshotRevision
        && lhs.isBusy == rhs.isBusy && lhs.isSaving == rhs.isSaving
        && lhs.isContinuing == rhs.isContinuing && lhs.error == rhs.error
        && lhs.needsContinuation == rhs.needsContinuation
    }

    func canConfirm(_ action: ChatPermissionAction, reviewing snapshot: ChatPermissionSnapshot?)
      -> Bool
    {
      let review = PermissionActionReview(action: action, snapshot: snapshot)
      return isActive && !isBusy && review.hasPermission && (!review.applied || needsContinuation)
    }
  }

  let action: ChatPermissionAction
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
    action: ChatPermissionAction, resources: PermissionCardResources, commands: ChatCommands,
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

  var read: PermissionCardRead<ChatPermissionSnapshot> { resources.read(action) }
  private var current: Presentation {
    do { return try store.get(model) } catch {
      preconditionFailure("Cannot read the permission card graph: \(error)")
    }
  }
  private var review: PermissionActionReview {
    PermissionActionReview(action: action, snapshot: snapshot)
  }
  var duration: ChatPermissionAction.Duration {
    get { current.duration }
    set { update { $0.duration = newValue } }
  }
  var snapshot: ChatPermissionSnapshot? { current.snapshot }
  var isActive: Bool { current.isActive }
  var isSaving: Bool { current.isSaving }
  var isContinuing: Bool { current.isContinuing }
  var error: String? { current.error }
  var needsContinuation: Bool { current.needsContinuation }
  var metadata: ChatPermissionMetadata? { review.metadata }
  var hasPermission: Bool { review.hasPermission }
  var applied: Bool { review.applied }
  var grant: ChatPermissionRule? { review.grant }
  var canConfirm: Bool { canConfirm(reviewing: snapshot) }
  var isBusy: Bool { operation != nil }

  func canConfirm(reviewing snapshot: ChatPermissionSnapshot?) -> Bool {
    !closed && current.canConfirm(action, reviewing: snapshot)
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
      let value = try await read.load(refresh: refresh)
      try Task.checkCancellation()
      guard !closed, isActive, operation == nil, self.generation == generation else { return }
      let applied = PermissionActionReview(action: action, snapshot: value).applied
      update {
        $0.snapshot = value
        $0.snapshotRevision += 1
        if refresh { $0.error = nil }
        if !applied { $0.needsContinuation = false }
      }
    } catch is CancellationError {
    } catch {
      guard !closed, isActive, operation == nil, self.generation == generation else { return }
      update {
        $0.snapshot = nil
        $0.snapshotRevision += 1
      }
    }
  }

  func confirm(reviewing reviewed: ChatPermissionSnapshot? = nil) async {
    let reviewed = reviewed ?? snapshot
    guard canConfirm(reviewing: reviewed), operation == nil, !Task.isCancelled else { return }
    let continuing =
      needsContinuation && PermissionActionReview(action: action, snapshot: reviewed).applied
    let retrying = error != nil || needsContinuation
    update {
      $0.isBusy = true
      $0.isSaving = true
      $0.isContinuing = continuing
      $0.error = nil
    }
    generation = UUID()
    let generation = generation
    let read = read
    let task = Task { [weak self, read] in
      guard let self else { return }
      defer {
        if self.generation == generation {
          update {
            $0.isBusy = false
            $0.isSaving = false
            $0.isContinuing = false
          }
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
        // Reuse the displayed review on first confirmation, as Web does. Explicit retries
        // read fresh state before deciding whether a write or continuation is still allowed.
        let current: ChatPermissionSnapshot
        if retrying {
          current = try await commands.permissions.load(action)
        } else {
          current = cached
        }
        try Task.checkCancellation()
        guard !closed, self.generation == generation else { return }
        confirmReview(current)
        guard hasPermission else {
          throw ChatError.invalidContract("This permission is no longer available.")
        }
        if continuing && !applied {
          throw ChatError.invalidContract("The permission changed. Review the request again.")
        }
        if !applied {
          let continues = action.callbackPrompt != nil
          update { $0.needsContinuation = continues }
          let result = try await commands.permissions.apply(
            action, duration: duration, reviewing: current)
          try Task.checkCancellation()
          guard !closed, self.generation == generation else { return }
          confirmReview(result)
        }
        // An already-applied request never resumes automatically after opening or refreshing.
        if needsContinuation, let prompt = action.callbackPrompt {
          update { $0.isContinuing = true }
          var delivered = false
          if continuationUncertain {
            try await commands.permissions.validateContext(action)
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
          // API acceptance completes the action. Conversation synchronization is separate.
          update {
            $0.needsContinuation = false
            $0.isSaving = false
            $0.isContinuing = false
          }
          await didContinue()
        }
      } catch is CancellationError {
      } catch {
        guard !closed, self.generation == generation else { return }
        let message = ChatRequestFailure.message(for: error)
        update { $0.error = message }
        didFail(error)
        // Read back an uncertain write without repeating it or sending a callback.
        let updated = try? await commands.permissions.load(action)
        guard let updated, !closed, self.generation == generation else { return }
        confirmReview(updated)
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
      $0.isBusy = false
      $0.isSaving = false
      $0.isContinuing = false
    }
  }

  func close() {
    closed = true
    deactivate()
  }

  private func confirmReview(_ snapshot: ChatPermissionSnapshot) {
    update {
      $0.snapshot = snapshot
      $0.snapshotRevision += 1
    }
  }

  // The card's state is a synchronous in-process value; replacing it cannot fail.
  private func update(_ mutation: (inout Presentation) -> Void) {
    var next = current
    mutation(&next)
    do { try store.set(model, next) } catch {
      preconditionFailure("Cannot update the permission card graph: \(error)")
    }
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
