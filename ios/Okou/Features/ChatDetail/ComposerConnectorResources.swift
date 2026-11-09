import CCState
import ChatData
import Foundation

/// One composer's immutable Agent/thread scope owns the shared overview reads.
@MainActor
final class ComposerConnectorResources {
  struct Connected: Sendable {
    let chatAccountAccess: Bool
    let connectors: [ChatComposerConnector]
  }

  struct Remote: Sendable {
    let overview: ChatRemotesOverview
    let access: ChatThreadRemoteAccess?
    let computer: ChatComputerAccess?
    let connections: [ChatVncConnection]
  }

  let store = CCState.Store()
  private let service: ChatComposerAccess
  private let agentID: String
  private let threadID: String?
  private let sleep: @Sendable (Duration) async throws -> Void
  private let didLoadConnected: @MainActor (Connected) -> Void
  private let didLoadRemote: @MainActor (Remote) -> Void
  private let didFail: @MainActor (Error) -> Void
  private let options: CCState.State<ChatComposerOptions>
  private let revision = CCState.State(0)
  private let lifetime = CCState.State(true)
  private let reload: Command<Void, ChatComposerOptions>
  private var connectedTask: Task<Connected, Error>?
  private var remoteTask: Task<Remote, Error>?
  private var closed = false

  init(
    service: ChatComposerAccess, agentID: String, threadID: String?, options: ChatComposerOptions,
    sleep: @escaping @Sendable (Duration) async throws -> Void,
    didLoadConnected: @escaping @MainActor (Connected) -> Void,
    didLoadRemote: @escaping @MainActor (Remote) -> Void,
    didFail: @escaping @MainActor (Error) -> Void
  ) {
    self.service = service
    self.agentID = agentID
    self.threadID = threadID
    self.sleep = sleep
    self.didLoadConnected = didLoadConnected
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

  lazy var connected = makeConnected()

  private func makeConnected() -> Computed<Task<Connected, Error>> {
    Computed { [weak self] get, options in
      guard let self, !closed, try get(lifetime) else { throw CancellationError() }
      _ = try get(revision)
      let pending = try get(self.options)
      let signal = options.signal
      let task = Task<Connected, Error> { @MainActor [weak self, service, agentID, threadID] in
        guard let self else { throw CancellationError() }
        do {
          let value = try await read {
            try await service.validate(agentID: agentID, threadID: threadID)
            try Task.checkCancellation()
            let enabled = try await service.chatAccountAccessEnabled()
            try Task.checkCancellation()
            let values = try await service.connectors(
              agentID: agentID, chatAccountAccess: enabled, threadID: threadID, options: pending)
            return Connected(chatAccountAccess: enabled, connectors: values)
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
      connectedTask = task
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

  func requests() throws -> (connected: Task<Connected, Error>, remote: Task<Remote, Error>) {
    // Start both independent sections before a caller awaits either endpoint.
    let connected = try store.get(connected)
    let remote = try store.get(remote)
    return (connected, remote)
  }

  func invalidate(options: ChatComposerOptions) throws {
    guard !closed else { throw CancellationError() }
    connectedTask?.cancel()
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
    connectedTask?.cancel()
    remoteTask?.cancel()
    connectedTask = nil
    remoteTask = nil
    do { try store.set(lifetime, false) } catch { didFail(error) }
  }

  isolated deinit {
    connectedTask?.cancel()
    remoteTask?.cancel()
  }
}
