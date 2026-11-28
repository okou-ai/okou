import CCState
import ChatData
import Foundation

/// One composer's workspace or thread owns the shared overview reads.
@MainActor
final class ComposerConnectorResources {
  struct Remote: Sendable {
    let overview: ChatRemotesOverview
    let access: ChatThreadRemoteAccess?
    let computer: ChatComputerAccess?
    let connections: [ChatVncConnection]
  }

  /// The workspace session's Store, which keeps these reads' graph values.
  let store: CCState.Store
  private let service: ChatComposerAccess

  private let threadID: String?
  private let includesRemote: Bool
  private let memberAccessEnabled: @MainActor () -> Bool
  private let sleep: @Sendable (Duration) async throws -> Void
  private let didLoadConnected: @MainActor ([ChatComposerConnector]) -> Void
  private let didInspect: @MainActor (Set<String>) -> Void
  private let didLoadRemote: @MainActor (Remote) -> Void
  private let didFail: @MainActor (Error) -> Void
  private let options: CCState.State<ChatComposerOptions>
  private let revision = CCState.State(0)
  private let lifetime = CCState.State(true)
  private let reload: Command<Void, ChatComposerOptions>
  private var overviewTask: Task<[ChatComposerConnector], Error>?
  private var inspectionTask: Task<[ChatComposerConnector], Error>?
  private var remoteTask: Task<Remote, Error>?
  private var closed = false

  init(
    service: ChatComposerAccess, graph: CCState.Store, threadID: String?,
    options: ChatComposerOptions, includesRemote: Bool = true,
    memberAccessEnabled: @escaping @MainActor () -> Bool,
    sleep: @escaping @Sendable (Duration) async throws -> Void,
    didLoadConnected: @escaping @MainActor ([ChatComposerConnector]) -> Void,
    didInspect: @escaping @MainActor (Set<String>) -> Void,
    didLoadRemote: @escaping @MainActor (Remote) -> Void,
    didFail: @escaping @MainActor (Error) -> Void
  ) {
    self.service = service
    store = graph
    self.threadID = threadID
    self.includesRemote = includesRemote
    self.memberAccessEnabled = memberAccessEnabled
    self.sleep = sleep
    self.didLoadConnected = didLoadConnected
    self.didInspect = didInspect
    self.didLoadRemote = didLoadRemote
    self.didFail = didFail
    let options = CCState.State(options)
    self.options = options
    let revision = revision
    reload = Command { context, value in
      try context.set(options, value)
      try context.set(revision, update: { $0 + 1 })
    }
  }

  lazy var overview = makeOverview()

  private func makeOverview() -> Computed<Task<[ChatComposerConnector], Error>> {
    Computed { [weak self] get, options in
      guard let self, !closed, try get(lifetime) else { throw CancellationError() }
      _ = try get(revision)
      let pending = try get(self.options)
      let signal = options.signal
      let task = Task { @MainActor [weak self, service, threadID] in
        guard let self else { throw CancellationError() }
        let memberAccess = memberAccessEnabled()
        do {
          let value = try await read {
            if !includesRemote {
              return try await service.managedConnectorOverview(memberAccess: memberAccess)
            }
            return try await service.connectors(
              threadID: threadID, options: pending, memberAccess: memberAccess)
          }
          try Task.checkCancellation()
          try signal.checkCancellation()
          guard !closed else { throw CancellationError() }
          didLoadConnected(value)
          return value
        } catch {
          if !closed, !Task.isCancelled, !signal.isCancelled { didFail(error) }
          throw error
        }
      }
      overviewTask = task
      signal.onCancel { task.cancel() }
      return task
    }
  }

  /// Settings renders the shared overview before this account inspection finishes.
  lazy var connected = includesRemote ? overview : makeInspectedOverview()

  private func makeInspectedOverview() -> Computed<Task<[ChatComposerConnector], Error>> {
    Computed { [weak self] get, options in
      guard let self, !closed, try get(lifetime) else { throw CancellationError() }
      let pending = try get(overview)
      let signal = options.signal
      let task = Task { @MainActor [weak self, service] in
        guard let self else { throw CancellationError() }
        // The overview owns its own retry and error reporting.
        let entries = try await pending.value
        do {
          let reconnect = try await read { try await service.reconnectAccountIDs(for: entries) }
          try Task.checkCancellation()
          try signal.checkCancellation()
          guard !closed else { throw CancellationError() }
          didInspect(reconnect)
          return entries
        } catch {
          if !closed, !Task.isCancelled, !signal.isCancelled { didFail(error) }
          throw error
        }
      }
      inspectionTask = task
      signal.onCancel { task.cancel() }
      return task
    }
  }

  lazy var remote = makeRemote()

  private func makeRemote() -> Computed<Task<Remote, Error>> {
    Computed { [weak self] get, options in
      guard let self, !closed, try get(lifetime) else { throw CancellationError() }
      _ = try get(revision)
      let signal = options.signal
      let task = Task<Remote, Error> { @MainActor [weak self, service, threadID] in
        guard let self else { throw CancellationError() }
        do {
          let value = try await read {
            let overview = try await service.remotes()
            var access: ChatThreadRemoteAccess?
            var computer: ChatComputerAccess?
            if let threadID {
              try Task.checkCancellation()
              access = try await service.remoteAccess(threadID: threadID)
              try Task.checkCancellation()
              computer = try await service.computerAccess(threadID: threadID)
            }
            try Task.checkCancellation()
            let connections =
              overview.vncHosts.isEmpty ? [] : try await service.vncConnections()
            return Remote(
              overview: overview, access: access, computer: computer, connections: connections)
          }
          try Task.checkCancellation()
          try signal.checkCancellation()
          guard !closed else { throw CancellationError() }
          didLoadRemote(value)
          return value
        } catch {
          if !closed, !Task.isCancelled, !signal.isCancelled { didFail(error) }
          throw error
        }
      }
      remoteTask = task
      signal.onCancel { task.cancel() }
      return task
    }
  }

  func requests() throws -> (
    connected: Task<[ChatComposerConnector], Error>, remote: Task<Remote, Error>
  ) {
    // Start both independent sections before a caller awaits either endpoint.
    let connected = try store.get(connected)
    let remote = try store.get(remote)
    return (connected, remote)
  }

  func invalidate(options: ChatComposerOptions) throws {
    guard !closed else { throw CancellationError() }
    overviewTask?.cancel()
    inspectionTask?.cancel()
    remoteTask?.cancel()
    try store.set(reload, options)
  }

  /// Keep the existing bounded read recovery, including one transport-cancellation retry.
  private func read<Value: Sendable>(_ body: @MainActor () async throws -> Value) async throws
    -> Value
  {
    try await ChatReadRecovery.read("connector settings", sleep: sleep) {
      guard !closed, !Task.isCancelled else { throw CancellationError() }
      do {
        return try await body()
      } catch {
        let cancelled = error is CancellationError || (error as? URLError)?.code == .cancelled
        guard !closed, !Task.isCancelled, cancelled else { throw error }
        return try await body()
      }
    }
  }

  enum Section { case connected, remote }

  static func message(for error: Error, in section: Section) -> String {
    if error is CancellationError || (error as? URLError)?.code == .cancelled {
      return section == .connected
        ? String(localized: "Could not load connectors. Try again.")
        : String(localized: "Could not load remote access. Try again.")
    }
    return ChatRequestFailure.message(for: error)
  }

  func close() {
    guard !closed else { return }
    closed = true
    overviewTask?.cancel()
    inspectionTask?.cancel()
    remoteTask?.cancel()
    inspectionTask = nil
    overviewTask = nil
    remoteTask = nil
    do { try store.set(lifetime, false) } catch { didFail(error) }
  }

  isolated deinit {
    overviewTask?.cancel()
    inspectionTask?.cancel()
    remoteTask?.cancel()
  }
}
