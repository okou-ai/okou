import CCState
import ChatData
import ChatDomain
import Foundation
import Observation

/// One conversation owns both the cached read and an explicit authorization attempt.
@MainActor @Observable
final class SSHAuthorizationStore {
  let action: ChatSSHAuthorizationAction
  let stateStore = CCState.Store()
  private(set) var isActive = false
  private(set) var isWorking = false
  private(set) var error: String?
  private let revision = CCState.State(0)
  private let lifetime = CCState.State(true)
  private let reload: Command<Void, Void>
  private let threadID: String
  private let client: APIClient
  private let didFail: @MainActor (Error) -> Void
  private let didContinue: @MainActor () async -> Void
  private let didRetainInteraction: @MainActor (SSHAuthorizationStore) -> Void
  @ObservationIgnored private var readTask: Task<ChatSSHAuthorization, Error>?
  @ObservationIgnored private var operation: Task<Void, Never>?
  @ObservationIgnored private var generation = UUID()
  @ObservationIgnored private var closed = false

  init(
    action: ChatSSHAuthorizationAction, threadID: String, client: APIClient,
    didFail: @escaping @MainActor (Error) -> Void,
    didContinue: @escaping @MainActor () async -> Void,
    didRetainInteraction: @escaping @MainActor (SSHAuthorizationStore) -> Void = { _ in }
  ) {
    self.action = action
    self.threadID = threadID.lowercased()
    self.client = client
    self.didFail = didFail
    self.didContinue = didContinue
    self.didRetainInteraction = didRetainInteraction
    let revision = revision
    reload = Command { context in try context.set(revision, update: { $0 + 1 }) }
  }

  @ObservationIgnored lazy var request = makeRequest()

  private func makeRequest() -> Computed<Task<ChatSSHAuthorization, Error>> {
    Computed { [weak self] get, options in
      guard let self, !closed, isActive, try get(lifetime) else { throw CancellationError() }
      guard action.threadID == threadID else {
        throw ChatError.invalidContract("This authorization belongs to a different chat.")
      }
      _ = try get(revision)
      let signal = options.signal
      let client = client
      let task = Task<ChatSSHAuthorization, Error> { @MainActor [action, weak self] in
        do {
          try Task.checkCancellation()
          let value = try await client.sshAuthorization(action)
          try Task.checkCancellation()
          try signal.checkCancellation()
          return value
        } catch {
          if let self, !closed, !Task.isCancelled, !signal.isCancelled { didFail(error) }
          throw error
        }
      }
      readTask = task
      signal.onCancel { task.cancel() }
      return task
    }
  }

  func read() async throws -> ChatSSHAuthorization {
    let generation = generation
    try checkOwner(generation)
    var task = try stateStore.get(request)
    while true {
      let result = await task.result
      try checkOwner(generation)
      let latest = try stateStore.get(request)
      if latest != task {
        task = latest
        continue
      }
      return try result.get()
    }
  }

  func activate() {
    guard !closed, !isActive else { return }
    isActive = true
    invalidate()
  }

  func invalidate() {
    guard !closed else { return }
    readTask?.cancel()
    do { try stateStore.set(reload) } catch { didFail(error) }
  }

  func refresh() async {
    guard isActive, !closed, operation == nil, !Task.isCancelled else { return }
    error = nil
    invalidate()
    // The resource Task owns its original failure; the card presents it with Retry.
    do { _ = try await read() } catch {}
  }

  enum Decision { case approve, revoke }

  func decide(_ decision: Decision) async {
    guard isActive, !closed, operation == nil, !Task.isCancelled else { return }
    didRetainInteraction(self)
    isWorking = true
    error = nil
    let generation = generation
    let task = Task { @MainActor [weak self] in
      guard let self else { return }
      defer {
        if self.generation == generation {
          isWorking = false
          operation = nil
        }
      }
      do {
        invalidate()
        let current = try await read()
        try checkOwner(generation)
        switch decision {
        case .approve:
          let status = current.effectiveStatus(at: .now)
          if status == .approved && !current.continuationPending { return }
          guard status == .pending || (status == .approved && current.continuationPending),
            current.approvalBlockedReason == nil
          else {
            throw ChatError.invalidContract("This request cannot be approved right now.")
          }
          // The same endpoint retries continuation without granting again. The client never
          // sends a callback message; the server owns its idempotency and queue receipt.
          _ = try await client.approveSSHAuthorization(action)
        case .revoke:
          guard current.status == .approved else {
            throw ChatError.invalidContract("This access can no longer be revoked.")
          }
          _ = try await client.revokeSSHAuthorization(action)
        }
        try checkOwner(generation)
        invalidate()
        _ = try await read()
        try checkOwner(generation)
        await didContinue()
      } catch is CancellationError {
      } catch {
        guard !closed, self.generation == generation, !Task.isCancelled else { return }
        self.error = ChatRequestFailure.message(for: error)
        didFail(error)
        // Reconcile an uncertain write without replaying approval or continuation.
        invalidate()
      }
    }
    operation = task
    await task.value
  }

  private func checkOwner(_ generation: UUID) throws {
    try Task.checkCancellation()
    guard !closed, isActive, self.generation == generation else { throw CancellationError() }
  }

  func deactivate() {
    isActive = false
    generation = UUID()
    readTask?.cancel()
    readTask = nil
    operation?.cancel()
    operation = nil
    isWorking = false
  }

  func close() {
    closed = true
    deactivate()
    do { try stateStore.set(lifetime, false) } catch { didFail(error) }
  }

  isolated deinit {
    readTask?.cancel()
    operation?.cancel()
  }
}
