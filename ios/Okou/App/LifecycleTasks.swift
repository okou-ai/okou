import Foundation

/// Keep original lifecycle work awaitable after its action handle is replaced or cancelled.
@MainActor
final class LifecycleTasks {
  private struct Pending {
    let cancel: () -> Void
    let completion: Task<Void, Never>
  }

  private var pending: [UUID: Pending] = [:]
  private var closed = false

  func track<Value: Sendable, Failure: Error>(_ task: Task<Value, Failure>) {
    if closed { task.cancel() }
    let id = UUID()
    let completion = Task { [weak self] in
      _ = await task.result
      self?.pending[id] = nil
    }
    pending[id] = Pending(cancel: { task.cancel() }, completion: completion)
  }

  /// Cancellation is synchronous; callers may await completion before disposing resources.
  @discardableResult
  func close(after children: [Task<Void, Never>] = []) -> Task<Void, Never> {
    for child in children { track(child) }
    closed = true
    let work = Array(pending.values)
    for item in work { item.cancel() }
    return Task {
      for item in work { await item.completion.value }
    }
  }

  isolated deinit {
    for item in pending.values { item.cancel() }
  }
}
