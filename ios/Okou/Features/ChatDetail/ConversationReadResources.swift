import CCState
import ChatData
import ChatDomain
import Foundation

/// One resident conversation owns these reads, independently of mounted detail waiters.
@MainActor
final class ConversationReadResources {
  enum Read: Equatable { case history, recovery }

  let store = CCState.Store()
  private let active = CCState.State(false)
  private let lifetime = CCState.State(true)
  private let historyRevision = CCState.State(0)
  private let recoveryRevision = CCState.State(0)
  private let reload: Command<Void, Read?>
  private let sync: ChatSync
  private let threadID: String
  private let markdown: MessageMarkdownCache
  private let sleep: @Sendable (Duration) async throws -> Void
  private var historyRequest: Task<ChatHistory?, Error>?
  private var recoveryRequest: Task<Bool?, Error>?
  private var closed = false

  init(
    sync: ChatSync, threadID: String, markdown: MessageMarkdownCache,
    sleep: @escaping @Sendable (Duration) async throws -> Void
  ) {
    self.sync = sync
    self.threadID = threadID
    self.markdown = markdown
    self.sleep = sleep
    let active = active
    let historyRevision = historyRevision
    let recoveryRevision = recoveryRevision
    reload = Command { context, read in
      let resuming = try !context.get(active)
      try context.set(active, true)
      if resuming || read == nil || read == .history {
        try context.set(historyRevision, update: { $0 + 1 })
      }
      if resuming || read == nil || read == .recovery {
        try context.set(recoveryRevision, update: { $0 + 1 })
      }
    }
  }

  /// Nil means demand is paused, not an empty authoritative history.
  lazy var history = makeHistory()
  lazy var recovery = makeRecovery()

  private func makeHistory() -> Computed<Task<ChatHistory?, Error>> {
    Computed { [weak self] get, options in
      guard let self, !closed, try get(lifetime) else { throw CancellationError() }
      let demanded = try get(active)
      _ = try get(historyRevision)
      let signal = options.signal
      let task = Task.immediate { @MainActor [sync, threadID, markdown, sleep] in
        guard demanded else { return Optional<ChatHistory>.none }
        try Task.checkCancellation()
        let result = try await ChatReadRecovery.read("chat history", sleep: sleep) {
          try await sync.eventHistory(threadID: threadID)
        }
        try Task.checkCancellation()
        try signal.checkCancellation()
        await markdown.prepareLatest(result.messages)
        try Task.checkCancellation()
        try signal.checkCancellation()
        return Optional(result)
      }
      historyRequest = task
      signal.onCancel { task.cancel() }
      return task
    }
  }

  private func makeRecovery() -> Computed<Task<Bool?, Error>> {
    Computed { [weak self] get, options in
      guard let self, !closed, try get(lifetime) else { throw CancellationError() }
      let demanded = try get(active)
      _ = try get(recoveryRevision)
      let signal = options.signal
      let task = Task.immediate { @MainActor [sync, threadID, sleep] in
        guard demanded else { return Optional<Bool>.none }
        try Task.checkCancellation()
        let result = try await ChatReadRecovery.read("cancellation recovery", sleep: sleep) {
          try await sync.cancellationRecoveryPending(threadID: threadID)
        }
        try Task.checkCancellation()
        try signal.checkCancellation()
        return Optional(result)
      }
      recoveryRequest = task
      signal.onCancel { task.cancel() }
      return task
    }
  }

  /// Full semantic refreshes invalidate both reads; an explicit section retry retains its peer.
  @discardableResult
  func refresh(_ read: Read? = nil) throws -> Read? {
    guard !closed else { throw CancellationError() }
    let resuming = try !store.get(active)
    if read == nil || read == .history { historyRequest?.cancel() }
    if read == nil || read == .recovery { recoveryRequest?.cancel() }
    try store.set(reload, read)
    return resuming ? nil : read
  }

  /// Background suspension cancels original I/O without retiring the confirmed conversation.
  func pause() throws {
    historyRequest?.cancel()
    recoveryRequest?.cancel()
    historyRequest = nil
    recoveryRequest = nil
    try store.set(active, false)
  }

  func close() throws {
    guard !closed else { return }
    closed = true
    try pause()
    try store.set(lifetime, false)
  }

  isolated deinit {
    historyRequest?.cancel()
    recoveryRequest?.cancel()
  }
}
