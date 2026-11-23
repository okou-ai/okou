import CCState
import ChatData
import Foundation

/// Read context for one failure in one detail visit. Mutations remain in their business owners.
@MainActor
final class FailureRecoveryResources {
  let failureID: String
  let store: CCState.Store
  let accounts: Computed<Task<[PersonalSubscription], Error>>
  private let subscriptions: PersonalSubscriptionResources
  private let lifetime = CCState.State(true)
  private let didFail: @MainActor (Error) -> Void
  private var closed = false

  init(
    failureID: String, subscriptions: PersonalSubscriptionResources,
    didFail: @escaping @MainActor (Error) -> Void
  ) {
    self.failureID = failureID
    store = subscriptions.store
    self.subscriptions = subscriptions
    self.didFail = didFail
    let lifetime = lifetime
    // Expose the workspace's original Task. Retiring a card must not cancel other readers.
    accounts = Computed { get in
      guard try get(lifetime) else { throw CancellationError() }
      return try get(subscriptions.value)
    }
  }

  func readAccounts() async throws -> [PersonalSubscription] {
    while !closed {
      try Task.checkCancellation()
      let task = try store.get(accounts)
      let result = await task.result
      try Task.checkCancellation()
      // Retired failures must stop before evaluating another owner's replacement read.
      guard !closed else { throw CancellationError() }
      if task != (try store.get(accounts)) { continue }
      return try result.get()
    }
    throw CancellationError()
  }

  func refresh() throws {
    guard !closed else { throw CancellationError() }
    // A previous failure's successful read is not fresh authority for this failure.
    try subscriptions.invalidate()
    _ = try store.get(accounts)
  }

  func close() {
    guard !closed else { return }
    closed = true
    // The workspace retains/cancels shared account I/O; only this failure's publication retires.
    do { try store.set(lifetime, false) } catch { didFail(error) }
  }
}
