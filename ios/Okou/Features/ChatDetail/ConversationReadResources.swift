import CCState
import ChatData
import ChatDomain
import Foundation

/// One resident conversation owns these independent reads. Confirmed history, delivery
/// reconciliation and native projection remain in ConversationStore, not in this graph.
@MainActor
final class ConversationReadResources {
  struct Reads {
    let history: Task<ChatHistory, Error>
    let recovery: Task<Bool, Error>

    // Cancel only this cycle's original work, never a replacement cycle's requests.
    func cancel() {
      history.cancel()
      recovery.cancel()
    }
  }

  private let store = CCState.Store()
  private let revision = CCState.State(0)
  private let lifetime = CCState.State(true)
  private let reload: Command<Void, Void>
  private let sync: ChatSync
  private let threadID: String
  private let sleep: @Sendable (Duration) async throws -> Void
  private let didFail: @MainActor (Error) -> Void
  private var historyTask: Task<ChatHistory, Error>?
  private var recoveryTask: Task<Bool, Error>?
  private var closed = false

  init(
    sync: ChatSync, threadID: String,
    sleep: @escaping @Sendable (Duration) async throws -> Void,
    didFail: @escaping @MainActor (Error) -> Void
  ) {
    self.sync = sync
    self.threadID = threadID
    self.sleep = sleep
    self.didFail = didFail
    let revision = revision
    let lifetime = lifetime
    reload = Command { context in
      guard try context.get(lifetime) else { throw CancellationError() }
      try context.set(revision, update: { $0 + 1 })
    }
  }

  private lazy var history = makeHistory()
  private lazy var recovery = makeRecovery()

  private func makeHistory() -> Computed<Task<ChatHistory, Error>> {
    Computed { [weak self] get, options in
      guard let self, !closed, try get(lifetime) else { throw CancellationError() }
      _ = try get(revision)
      let signal = options.signal
      let task = Task<ChatHistory, Error> { @MainActor [sync, threadID, sleep] in
        let value = try await ChatReadRecovery.read("chat history", sleep: sleep) {
          try await sync.eventHistory(threadID: threadID)
        }
        try Task.checkCancellation()
        try signal.checkCancellation()
        return value
      }
      historyTask = task
      signal.onCancel { task.cancel() }
      return task
    }
  }

  private func makeRecovery() -> Computed<Task<Bool, Error>> {
    Computed { [weak self] get, options in
      guard let self, !closed, try get(lifetime) else { throw CancellationError() }
      _ = try get(revision)
      let signal = options.signal
      let task = Task<Bool, Error> { @MainActor [sync, threadID, sleep] in
        let value = try await ChatReadRecovery.read("cancellation recovery", sleep: sleep) {
          try await sync.cancellationRecoveryPending(threadID: threadID)
        }
        try Task.checkCancellation()
        try signal.checkCancellation()
        return value
      }
      recoveryTask = task
      signal.onCancel { task.cancel() }
      return task
    }
  }

  /// Semantic refresh/realtime/foreground entry points request a new cycle. Merely
  /// hiding a detail or cancelling a UI waiter does not invalidate resident reads.
  func refresh() throws -> Reads {
    try Task.checkCancellation()
    guard !closed else { throw CancellationError() }
    pause()
    try store.set(reload)
    do {
      // Start both original Tasks before awaiting either; recovery cannot gate messages.
      return Reads(history: try store.get(history), recovery: try store.get(recovery))
    } catch {
      pause()
      throw error
    }
  }

  /// Background pause retires I/O; a later explicit refresh creates fresh Tasks.
  func pause() {
    historyTask?.cancel()
    historyTask = nil
    recoveryTask?.cancel()
    recoveryTask = nil
  }

  func close() {
    guard !closed else { return }
    closed = true
    pause()
    do { try store.set(lifetime, false) } catch { didFail(error) }
  }

  isolated deinit {
    historyTask?.cancel()
    recoveryTask?.cancel()
  }
}
