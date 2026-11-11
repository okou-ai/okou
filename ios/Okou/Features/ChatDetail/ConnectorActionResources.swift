import CCState
import ChatData
import Foundation

/// A conversation shares status reads; authorization attempts retain their own protocol state.
@MainActor
final class ConnectorActionResources {
  private final class Key: NSObject {
    let components: [String?]

    init(_ action: ChatConnectorAction) {
      let kind: String
      let target: ChatConnectorTarget?
      let account: String?
      switch action.kind {
      case .connect(let slug):
        kind = "connect"
        // A custom slug is resolved by the service, not substituted for a custom connector ID.
        target = .builtin(slug)
        account = nil
      case .reconnect(let slug, let id):
        kind = "reconnect"
        target = .builtin(slug)
        account = id
      case .select(let value, let id):
        kind = "select"
        target = value
        account = id
      case .configuration(let value, let id):
        kind = "configuration"
        target = value
        account = id
      case .unavailable:
        kind = "unavailable"
        target = nil
        account = nil
      }
      components = [
        kind, action.agentID.lowercased(), action.threadID?.lowercased(), target?.kind,
        target?.connectorSlug, target?.customConnectorId?.lowercased(),
        account?.lowercased(),
      ]
    }

    override var hash: Int { components.hashValue }
    override func isEqual(_ object: Any?) -> Bool {
      (object as? Key)?.components == components
    }
  }

  private final class WeakRead {
    weak var value: ConnectorActionRead?
    init(_ value: ConnectorActionRead) { self.value = value }
  }

  private let service: ChatConnectorService
  private let didFail: @MainActor (Error) -> Void
  private let cache: NSCache<Key, ConnectorActionRead> = {
    let cache = NSCache<Key, ConnectorActionRead>()
    cache.countLimit = 64
    return cache
  }()
  private var live: [Key: WeakRead] = [:]
  private var pending: [Key: ConnectorActionRead] = [:]
  private var closed = false

  init(service: ChatConnectorService, didFail: @escaping @MainActor (Error) -> Void) {
    self.service = service
    self.didFail = didFail
  }

  func read(_ action: ChatConnectorAction) -> ConnectorActionRead {
    let key = Key(action)
    if let value = pending[key] ?? cache.object(forKey: key) ?? live[key]?.value { return value }
    live = live.filter { $0.value.value != nil }
    let value = ConnectorActionRead(action: action, owner: self)
    if closed {
      value.close()
    } else {
      live[key] = WeakRead(value)
      cache.setObject(value, forKey: key)
    }
    return value
  }

  func refreshKnown() async {
    guard !closed else { return }
    live = live.filter { $0.value.value != nil }
    for read in live.values.compactMap(\.value) {
      guard !closed, !Task.isCancelled else { return }
      _ = await read.result(refresh: true)
    }
  }

  fileprivate func started(_ read: ConnectorActionRead) { pending[Key(read.action)] = read }

  fileprivate func finished(_ read: ConnectorActionRead, request: UUID) {
    read.finish(request)
    let key = Key(read.action)
    if !read.isReading, pending[key] === read { pending[key] = nil }
    // Cache policy is advisory. Mounted readers, pending I/O and the active attempt retain
    // their read owner independently, so eviction never cancels another consumer's work.
    if !closed { cache.setObject(read, forKey: key) }
    live = live.filter { $0.value.value != nil }
  }

  fileprivate func load(_ action: ChatConnectorAction) async throws -> ChatConnectorStatus? {
    guard !closed else { throw CancellationError() }
    if action.kind == .unavailable { return nil }
    return try await service.status(action)
  }

  fileprivate func report(_ error: Error) { if !closed { didFail(error) } }

  func close() {
    guard !closed else { return }
    closed = true
    for read in live.values.compactMap(\.value) { read.close() }
    pending = [:]
    cache.removeAllObjects()
    live = [:]
  }
}

@MainActor
final class ConnectorActionRead {
  let store = CCState.Store()
  /// Native measurement-only rows may observe an existing read without starting one.
  let requested: Computed<Bool>
  fileprivate let action: ChatConnectorAction
  private weak var owner: ConnectorActionResources?
  private let demand = CCState.State(false)
  private let lifetime = CCState.State(true)
  private let revision = CCState.State(0)
  private let request: Command<Void, Bool>
  private var original: Task<ChatConnectorStatus?, Error>?
  private var pendingID: UUID?
  private var closed = false
  fileprivate var isReading: Bool { pendingID != nil }

  fileprivate init(action: ChatConnectorAction, owner: ConnectorActionResources) {
    self.action = action
    self.owner = owner
    let demand = demand
    let lifetime = lifetime
    let revision = revision
    requested = Computed { get in try get(lifetime) && get(demand) }
    request = Command { context, invalidate in
      if try !context.get(demand) { try context.set(demand, true) }
      if invalidate { try context.set(revision, update: { $0 + 1 }) }
    }
  }

  lazy var value = makeValue()

  private func makeValue() -> Computed<Task<ChatConnectorStatus?, Error>> {
    Computed { [weak self] get, options in
      guard let self, let owner, !closed, try get(lifetime), try get(demand) else {
        throw CancellationError()
      }
      _ = try get(revision)
      let signal = options.signal
      let id = UUID()
      pendingID = id
      owner.started(self)
      let task = Task<ChatConnectorStatus?, Error> { @MainActor [self, owner] in
        defer { owner.finished(self, request: id) }
        do {
          try Task.checkCancellation()
          let result = try await owner.load(action)
          try Task.checkCancellation()
          try signal.checkCancellation()
          guard !closed else { throw CancellationError() }
          return result
        } catch {
          if !closed, !Task.isCancelled, !signal.isCancelled { owner.report(error) }
          throw error
        }
      }
      original = task
      signal.onCancel { task.cancel() }
      return task
    }
  }

  /// Repeated mounted consumers share the existing Task. Only an explicit refresh retries.
  func load(refresh: Bool = false) async throws -> ChatConnectorStatus? {
    guard !closed, !Task.isCancelled else { throw CancellationError() }
    try store.set(request, refresh && pendingID == nil)
    var task = try store.get(value)
    while !closed {
      let result = await task.result
      try Task.checkCancellation()
      guard !closed else { throw CancellationError() }
      let current = try store.get(value)
      if task != current {
        task = current
        continue
      }
      return try result.get()
    }
    throw CancellationError()
  }

  func result(refresh: Bool = false) async -> Result<ChatConnectorStatus?, Error> {
    do { return .success(try await load(refresh: refresh)) } catch { return .failure(error) }
  }

  /// A confirmed authorization changes status, but never replays the protocol or continuation.
  func invalidate() {
    guard !closed else { return }
    original?.cancel()
    pendingID = nil
    do { try store.set(request, true) } catch {
      preconditionFailure("Cannot invalidate local Connector status inputs: \(error)")
    }
  }

  fileprivate func finish(_ id: UUID) {
    if pendingID == id { pendingID = nil }
  }

  fileprivate func close() {
    guard !closed else { return }
    closed = true
    original?.cancel()
    original = nil
    pendingID = nil
    do { try store.set(lifetime, false) } catch {
      preconditionFailure("Cannot retire local Connector status inputs: \(error)")
    }
  }

  isolated deinit { original?.cancel() }
}
