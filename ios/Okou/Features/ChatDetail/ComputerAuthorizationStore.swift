import CCState
import ChatData
import ChatDomain
import Foundation

/// One conversation owns both the cached read and an explicit authorization attempt.
@MainActor
final class ComputerAuthorizationStore {
  /// The computer choice and the explicit grant, denial or continuation attempt.
  struct Attempt: Equatable {
    var chosenHostID: String?
    var isWorking = false
    var needsContinuation = false
    var hasContinued = false
    var error: String?
  }

  /// What the card shows besides the request: whether its transcript row reads the request,
  /// and the attempt.
  struct Presentation: Equatable {
    var isActive = false
    var attempt = Attempt()
  }

  let action: ChatComputerAuthorizationAction
  /// The workspace session Store that keeps this card's graph values.
  let stateStore: CCState.Store
  let presentation: Computed<Presentation>
  // The read is available only while the row is active, so activation is a graph input.
  private let active = CCState.State(false)
  private let attempt = CCState.State(Attempt())
  private let revision = CCState.State(0)
  private let lifetime = CCState.State(true)
  private let reload: Command<Void, Void>
  private let thread: ChatThread
  private let commands: ChatCommands
  private let sync: ChatSync
  private let didFail: @MainActor (Error) -> Void
  private let didContinue: @MainActor () async -> Void
  private let didRetainInteraction: @MainActor (ComputerAuthorizationStore) -> Void
  private var readTask: Task<ChatComputerAuthorizationRequest, Error>?
  private var operation: Task<Void, Never>?
  private var generation = UUID()
  private var closed = false

  var isActive: Bool { value(of: active) }
  var chosenHostID: String? { value(of: attempt).chosenHostID }
  var isWorking: Bool { value(of: attempt).isWorking }
  var needsContinuation: Bool { value(of: attempt).needsContinuation }
  var hasContinued: Bool { value(of: attempt).hasContinued }
  var error: String? { value(of: attempt).error }

  init(
    action: ChatComputerAuthorizationAction, thread: ChatThread, commands: ChatCommands,
    sync: ChatSync, graph: CCState.Store, didFail: @escaping @MainActor (Error) -> Void,
    didContinue: @escaping @MainActor () async -> Void,
    didRetainInteraction: @escaping @MainActor (ComputerAuthorizationStore) -> Void = { _ in }
  ) {
    self.action = action
    stateStore = graph
    self.thread = thread
    self.commands = commands
    self.sync = sync
    self.didFail = didFail
    self.didContinue = didContinue
    self.didRetainInteraction = didRetainInteraction
    let revision = revision
    reload = Command { context in try context.set(revision, update: { $0 + 1 }) }
    let active = active
    let attempt = attempt
    presentation = Computed { get in
      let isActive = try get(active)
      let current = try get(attempt)
      return Presentation(isActive: isActive, attempt: current)
    }
  }

  lazy var request = makeRequest()

  private func makeRequest() -> Computed<Task<ChatComputerAuthorizationRequest, Error>> {
    Computed { [weak self] get, options in
      guard let self, !closed, try get(active), try get(lifetime) else {
        throw CancellationError()
      }
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

  func selectedHost(in request: ChatComputerAuthorizationRequest) -> String? {
    Self.selectedHost(in: request, chosen: chosenHostID)
  }

  /// The user's choice or the request's preferred computer when online, else the only online one.
  static func selectedHost(in request: ChatComputerAuthorizationRequest, chosen: String?)
    -> String?
  {
    let hosts = request.hosts.filter { $0.status == "online" }
    if let preferred = chosen ?? request.computerUseHostID,
      hosts.contains(where: { $0.id == preferred })
    {
      return preferred
    }
    return chosen == nil && hosts.count == 1 ? hosts.first?.id : nil
  }

  func selectHost(_ id: String?) {
    guard isActive, !closed, id != chosenHostID else { return }
    update { $0.chosenHostID = id }
    didRetainInteraction(self)
  }

  func activate() {
    guard !closed, !isActive else { return }
    // Activation is a dependency of the read, so the next read revalidates the request.
    write(active, true)
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
    didRetainInteraction(self)
    update {
      $0.isWorking = true
      $0.error = nil
    }
    let generation = generation
    let task = Task { @MainActor [weak self] in
      guard let self else { return }
      defer {
        if self.generation == generation {
          update { $0.isWorking = false }
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
            let continues = action.callbackPrompt != nil
            update { $0.needsContinuation = continues }
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
                chatThreadSortEventID: current.id)
            }
            try checkOwner(generation)
            update {
              $0.needsContinuation = false
              $0.hasContinued = true
            }
          }
        case .deny:
          guard action.kind == .shell, current.effectiveStatus(at: .now) == .pending else {
            throw ChatError.invalidContract("This request can no longer be denied.")
          }
          _ = try await commands.approvalClient.denyShellAuthorization(id: action.identifier)
          try checkOwner(generation)
          update { $0.needsContinuation = false }
        case .revoke:
          guard action.kind == .shell, current.effectiveStatus(at: .now) == .approved else {
            throw ChatError.invalidContract("This access can no longer be revoked.")
          }
          _ = try await commands.approvalClient.revokeShellAuthorization(id: action.identifier)
          try checkOwner(generation)
          update { $0.needsContinuation = false }
        }
        try checkOwner(generation)
        invalidate()
        await didContinue()
      } catch is CancellationError {
      } catch {
        guard !closed, self.generation == generation, !Task.isCancelled else { return }
        let message = ChatRequestFailure.message(for: error)
        update { $0.error = message }
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
    write(active, false)
    generation = UUID()
    readTask?.cancel()
    readTask = nil
    operation?.cancel()
    operation = nil
    update { $0.isWorking = false }
  }

  func close() {
    closed = true
    deactivate()
    do { try stateStore.set(lifetime, false) } catch { didFail(error) }
  }

  // The card's own states are synchronous in-process values; reads and writes cannot fail.
  private func value<Value>(of signal: Signal<Value>) -> Value {
    do { return try stateStore.get(signal) } catch {
      preconditionFailure("Cannot read the computer access card graph: \(error)")
    }
  }

  private func write<Value>(_ state: CCState.State<Value>, _ value: Value) {
    do { try stateStore.set(state, value) } catch {
      preconditionFailure("Cannot update the computer access card graph: \(error)")
    }
  }

  private func update(_ mutation: (inout Attempt) -> Void) {
    var next = value(of: attempt)
    mutation(&next)
    write(attempt, next)
  }

  isolated deinit {
    readTask?.cancel()
    operation?.cancel()
  }
}
