import CCState
import Foundation

/// A detail visit owns the original read, independently of row and sheet waiters.
@MainActor
final class PermissionReadResource<Value: Sendable> {
  let store: CCState.Store
  private let revision = CCState.State(0)
  private let available = CCState.State(false)
  private let reload: Command<Void, Void>
  private let changeAvailability: Command<Void, Bool>
  private let read: @MainActor () async throws -> Value
  private let didFail: @MainActor (Error) -> Void
  private var current: Task<Value, Error>?
  private var generation = UUID()
  private var closed = false
  // Measurement-only rows preserve their layout without acquiring an HTTP read.
  let unrequested = Computed<Task<Value, Error>> { _ in Task { throw CancellationError() } }

  init(
    store: CCState.Store, read: @escaping @MainActor () async throws -> Value,
    didFail: @escaping @MainActor (Error) -> Void
  ) {
    self.store = store
    self.read = read
    self.didFail = didFail
    let revision = revision
    let available = available
    reload = Command { context in try context.set(revision, update: { $0 + 1 }) }
    changeAvailability = Command { context, active in
      try context.set(available, active)
      if !active { try context.set(revision, update: { $0 + 1 }) }
    }
  }

  lazy var value = Computed<Task<Value, Error>> { [weak self] get, options in
    guard let self, try get(available), !closed else { throw CancellationError() }
    _ = try get(revision)
    let generation = generation
    let signal = options.signal
    let task = Task<Value, Error> { @MainActor [weak self, read] in
      do {
        try Task.checkCancellation()
        let result = try await read()
        try Task.checkCancellation()
        try signal.checkCancellation()
        guard let self, !closed, self.generation == generation else { throw CancellationError() }
        return result
      } catch {
        if let self, !closed, self.generation == generation,
          !Task.isCancelled, !signal.isCancelled
        {
          didFail(error)
        }
        throw error
      }
    }
    current = task
    signal.onCancel { task.cancel() }
    return task
  }

  func load() async throws -> Value {
    try await store.get(value).value
  }

  func invalidate() {
    guard !closed else { return }
    generation = UUID()
    current?.cancel()
    current = nil
    do { try store.set(reload) } catch { didFail(error) }
  }

  func activate() {
    guard !closed else { return }
    do { try store.set(changeAvailability, true) } catch { didFail(error) }
  }

  func deactivate() {
    generation = UUID()
    current?.cancel()
    current = nil
    do {
      try store.set(changeAvailability, false)
    } catch { didFail(error) }
  }

  func close() {
    closed = true
    deactivate()
  }

  isolated deinit { current?.cancel() }
}
