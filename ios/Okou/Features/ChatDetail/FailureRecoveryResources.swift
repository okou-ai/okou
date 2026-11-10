import CCState
import ChatData
import ChatDomain
import Foundation

/// Read context for one failure in one detail visit. Mutations remain in their business owners.
@MainActor
final class FailureRecoveryResources {
  let failureID: String
  let store: CCState.Store
  let accounts: Computed<Task<[PersonalSubscription], Error>>?
  private(set) var billing: Computed<Task<ChatBillingRecovery, Error>>?
  private let subscriptions: PersonalSubscriptionResources?
  private let lifetime = CCState.State(true)
  private let billingRevision = CCState.State(0)
  private let reloadBilling: Command<Void, Void>
  private let didFail: @MainActor (Error) -> Void
  private var billingTask: Task<ChatBillingRecovery, Error>?
  private var closed = false

  init(
    failure: ChatFailure, subscriptions: PersonalSubscriptionResources?, commands: ChatCommands,
    didFail: @escaping @MainActor (Error) -> Void
  ) {
    failureID = failure.id
    store = subscriptions?.store ?? CCState.Store()
    self.subscriptions = subscriptions
    self.didFail = didFail
    let lifetime = lifetime
    let revision = billingRevision
    reloadBilling = Command { context in try context.set(revision, update: { $0 + 1 }) }
    if failure.recovery(personalFramework: nil).kind == .usage, let subscriptions {
      // Expose the workspace's original Task. Retiring a card must not cancel other readers.
      accounts = Computed { get in
        guard try get(lifetime) else { throw CancellationError() }
        return try get(subscriptions.value)
      }
    } else {
      accounts = nil
    }
    billing = nil
    if failure.recovery(personalFramework: nil).kind == .billing {
      // Initialized below through makeBilling so its original request has a teardown owner.
      self.billing = makeBilling(commands: commands)
    }
  }

  private func makeBilling(commands: ChatCommands) -> Computed<Task<ChatBillingRecovery, Error>> {
    Computed { [weak self] get, options in
      guard let self, !closed, try get(lifetime) else { throw CancellationError() }
      _ = try get(billingRevision)
      let signal = options.signal
      let task = Task<ChatBillingRecovery, Error> { @MainActor [weak self] in
        do {
          try Task.checkCancellation()
          let result = try await commands.billingRecovery()
          try Task.checkCancellation()
          try signal.checkCancellation()
          guard let self, !closed else { throw CancellationError() }
          return result
        } catch {
          if let self, !closed, !Task.isCancelled, !signal.isCancelled { didFail(error) }
          throw error
        }
      }
      billingTask = task
      signal.onCancel { task.cancel() }
      return task
    }
  }

  func readAccounts() async throws -> [PersonalSubscription] {
    guard let accounts else { throw CancellationError() }
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

  func start() throws {
    guard !closed else { throw CancellationError() }
    // A previous failure's successful read is not fresh authority for this failure.
    if let accounts {
      try subscriptions?.invalidate()
      _ = try store.get(accounts)
    }
    if let billing { _ = try store.get(billing) }
  }

  func retry() throws {
    guard !closed else { throw CancellationError() }
    if let accounts {
      try subscriptions?.invalidate()
      _ = try store.get(accounts)
    }
    if let billing {
      billingTask?.cancel()
      try store.set(reloadBilling)
      _ = try store.get(billing)
    }
  }

  func close() {
    guard !closed else { return }
    closed = true
    billingTask?.cancel()
    billingTask = nil
    // The workspace retains/cancels shared account I/O; only this failure's publication retires.
    do { try store.set(lifetime, false) } catch { didFail(error) }
  }

  isolated deinit { billingTask?.cancel() }
}
