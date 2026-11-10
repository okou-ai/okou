import CCState
import ChatData
import ChatDomain
import Foundation
import Observation

/// One conversation owns both the cached read and an explicit authorization attempt.
@MainActor @Observable
final class ComputerAuthorizationStore {
  let action: ChatComputerAuthorizationAction
  let stateStore = CCState.Store()
  var chosenHostID: String?
  private(set) var isActive = false
  private(set) var isWorking = false
  private(set) var needsContinuation = false
  private(set) var hasContinued = false
  private(set) var error: String?
  private let revision = CCState.State(0)
  private let lifetime = CCState.State(true)
  private let reload: Command<Void, Void>
  private let thread: ChatThread
  private let commands: ChatCommands
  private let sync: ChatSync
  private let didFail: @MainActor (Error) -> Void
  private let didContinue: @MainActor () async -> Void
  @ObservationIgnored private var readTask: Task<ChatComputerAuthorizationRequest, Error>?
  @ObservationIgnored private var operation: Task<Void, Never>?
  @ObservationIgnored private var generation = UUID()
  @ObservationIgnored private var closed = false

  init(
    action: ChatComputerAuthorizationAction, thread: ChatThread, commands: ChatCommands,
    sync: ChatSync, didFail: @escaping @MainActor (Error) -> Void,
    didContinue: @escaping @MainActor () async -> Void
  ) {
    self.action = action
    self.thread = thread
    self.commands = commands
    self.sync = sync
    self.didFail = didFail
    self.didContinue = didContinue
    let revision = revision
    reload = Command { context in try context.set(revision, update: { $0 + 1 }) }
  }

  @ObservationIgnored lazy var request = makeRequest()

  private func makeRequest() -> Computed<Task<ChatComputerAuthorizationRequest, Error>> {
    Computed { [weak self] get, options in
      guard let self, !closed, isActive, try get(lifetime) else { throw CancellationError() }
      guard action.threadID.lowercased() == thread.id.lowercased() else {
        throw ChatError.invalidContract("This authorization belongs to a different chat.")
      }
      _ = try get(revision)
      let signal = options.signal
      let client = commands.approvalClient
      let task = Task<ChatComputerAuthorizationRequest, Error> { @MainActor [action, weak self] in
        do {
          try Task.checkCancellation()
          let value = try await client.computerAuthorization(action)
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

  func read() async throws -> ChatComputerAuthorizationRequest {
    try await stateStore.get(request).value
  }

  func selectedHost(in request: ChatComputerAuthorizationRequest) -> String? {
    let hosts = request.hosts.filter { $0.status == "online" }
    if let preferred = chosenHostID ?? request.computerUseHostID,
      hosts.contains(where: { $0.id == preferred })
    {
      return preferred
    }
    return chosenHostID == nil && hosts.count == 1 ? hosts.first?.id : nil
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
    invalidate()
    // The resource Task owns its original failure; the card presents it with Retry.
    do { _ = try await read() } catch {}
  }

  enum Decision { case approve, deny, revoke }

  func decide(_ decision: Decision) async {
    guard isActive, !closed, operation == nil, !Task.isCancelled else { return }
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
        var current = try await read()
        try checkOwner(generation)
        switch decision {
        case .approve:
          if current.effectiveStatus(at: .now) == .pending {
            guard current.approvalBlockedReason == nil else {
              throw ChatError.invalidContract("This request cannot be approved right now.")
            }
            let host = selectedHost(in: current)
            if action.kind == .computerUse && host == nil {
              throw ChatError.invalidContract("Choose an online computer before authorizing.")
            }
            needsContinuation = action.callbackPrompt != nil
            try await commands.approvalClient.applyComputerAuthorization(action, hostID: host)
            try checkOwner(generation)
            invalidate()
            current = try await read()
            try checkOwner(generation)
          }
          guard current.effectiveStatus(at: .now) == .approved else {
            throw ChatError.invalidContract("This authorization is no longer available.")
          }
          if needsContinuation, let prompt = action.callbackPrompt {
            let history = try await sync.eventHistory(threadID: thread.id)
            try checkOwner(generation)
            if !history.persistedEventIDs.contains(current.id.lowercased()) {
              _ = try await commands.send(
                thread: thread, text: prompt, clientEventID: current.id,
                chatThreadSortEventID: current.id, expectedAgentID: thread.agentID)
            }
            try checkOwner(generation)
            needsContinuation = false
            hasContinued = true
          }
        case .deny:
          guard action.kind == .shell, current.effectiveStatus(at: .now) == .pending else {
            throw ChatError.invalidContract("This request can no longer be denied.")
          }
          _ = try await commands.approvalClient.denyShellAuthorization(id: action.identifier)
          try checkOwner(generation)
          needsContinuation = false
        case .revoke:
          guard action.kind == .shell, current.effectiveStatus(at: .now) == .approved else {
            throw ChatError.invalidContract("This access can no longer be revoked.")
          }
          _ = try await commands.approvalClient.revokeShellAuthorization(id: action.identifier)
          try checkOwner(generation)
          needsContinuation = false
        }
        try checkOwner(generation)
        invalidate()
        await didContinue()
      } catch is CancellationError {
      } catch {
        guard !closed, self.generation == generation, !Task.isCancelled else { return }
        self.error = ChatRequestFailure.message(for: error)
        didFail(error)
        // Reconcile an uncertain grant without replaying a write or a callback.
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
