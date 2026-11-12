import CCState
import ChatData
import Foundation

/// Account/session reads survive workspace switches, but never identity replacement.
@MainActor
final class AccountMembershipResources {
  let sessionID: String
  let userID: String
  var scopeID: String { "\(userID):\(sessionID)" }
  let store = CCState.Store()
  private let revision = CCState.State(0)
  private let lifetime = CCState.State(true)
  private let reload: Command<Void, Void>
  private let read: @MainActor () async throws -> [WorkspacePresentation]
  private let didFail: @MainActor (Error) -> Void
  private var current: Task<[WorkspacePresentation], Error>?
  private var closed = false

  init(
    sessionID: String, userID: String,
    read: @escaping @MainActor () async throws -> [WorkspacePresentation],
    didFail: @escaping @MainActor (Error) -> Void
  ) {
    self.sessionID = sessionID
    self.userID = userID
    self.read = read
    self.didFail = didFail
    let revision = revision
    let lifetime = lifetime
    reload = Command { context in
      guard try context.get(lifetime) else { throw CancellationError() }
      try context.set(revision, update: { $0 + 1 })
    }
  }

  lazy var value = makeValue()

  private func makeValue() -> Computed<Task<[WorkspacePresentation], Error>> {
    Computed { [weak self] get, options in
      guard let self, !closed, try get(lifetime) else { throw CancellationError() }
      _ = try get(revision)
      let signal = options.signal
      let task = Task<[WorkspacePresentation], Error> { @MainActor [read] in
        try Task.checkCancellation()
        let result = try await read()
        try Task.checkCancellation()
        try signal.checkCancellation()
        return result
      }
      current = task
      signal.onCancel { task.cancel() }
      return task
    }
  }

  /// Only a semantic refresh retries a settled read; UI observation borrows its Task.
  func refresh() throws -> Task<[WorkspacePresentation], Error> {
    try Task.checkCancellation()
    guard !closed else { throw CancellationError() }
    current?.cancel()
    try store.set(reload)
    return try store.get(value)
  }

  func close() {
    guard !closed else { return }
    closed = true
    current?.cancel()
    current = nil
    do { try store.set(lifetime, false) } catch { didFail(error) }
  }

  isolated deinit { current?.cancel() }
}
