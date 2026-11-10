import CCState
import ChatData
import Foundation

/// Repeatable status reads only. Authorization attempts and continuation receipts stay elsewhere.
@MainActor
final class ConnectorActionResources {
  struct Key: Hashable {
    enum Target: Hashable {
      case slug(String)
      case account(kind: String, slug: String?, customID: String?)
      case unavailable
    }
    let agentID: String
    let threadID: String?
    let operation: String
    let target: Target
    let accountID: String?

    init(_ action: ChatConnectorAction) {
      agentID = action.agentID.lowercased()
      threadID = action.threadID?.lowercased()
      func targetKey(_ value: ChatConnectorTarget) -> Target {
        .account(
          kind: value.kind, slug: value.connectorSlug?.lowercased(),
          customID: value.customConnectorId?.lowercased())
      }
      switch action.kind {
      case .connect(let slug):
        operation = "connect"
        target = .slug(slug.lowercased())
        accountID = nil
      case .reconnect(let slug, let id):
        operation = "reconnect"
        target = .slug(slug.lowercased())
        accountID = id.lowercased()
      case .select(let value, let id):
        operation = "select"
        target = targetKey(value)
        accountID = id.lowercased()
      case .configuration(let value, let id):
        operation = "configuration"
        target = targetKey(value)
        accountID = id?.lowercased()
      case .unavailable:
        operation = "unavailable"
        target = .unavailable
        accountID = nil
      }
    }
  }

  let store = CCState.Store()
  fileprivate let lifetime = CCState.State(true)
  private let service: ChatConnectorService
  private let didFail: @MainActor (Error) -> Void
  private final class WeakRead {
    weak var value: ConnectorActionStatusRead?
    init(_ value: ConnectorActionStatusRead) { self.value = value }
  }
  private var live: [Key: WeakRead] = [:]
  private var pending: [Key: ConnectorActionStatusRead] = [:]
  private var recent: [ConnectorActionStatusRead] = []
  private var closed = false

  init(service: ChatConnectorService, didFail: @escaping @MainActor (Error) -> Void) {
    self.service = service
    self.didFail = didFail
  }

  /// Retain at most 64 idle entries, in addition to mounted consumers and original in-flight I/O.
  /// Eviction drops only cache ownership. The last consumer releases the graph/Task; close()
  /// explicitly retires every live read. No authorization or uncertain write lives in this cache.
  func status(_ action: ChatConnectorAction) -> ConnectorActionStatusRead {
    let key = Key(action)
    let read = live[key]?.value ?? ConnectorActionStatusRead(action: action, owner: self)
    guard !closed else { return read }
    live = live.filter { $0.value.value != nil }
    live[key] = WeakRead(read)
    recent.removeAll { $0 === read }
    recent.append(read)
    if recent.count > 64 { recent.removeFirst(recent.count - 64) }
    return read
  }

  func refresh(_ action: ChatConnectorAction) async throws -> ChatConnectorStatus? {
    try Task.checkCancellation()
    guard !closed else { throw CancellationError() }
    let read = status(action)
    if !read.isPending { try read.invalidate(in: store) }
    let value = try await store.get(read.value).value
    try Task.checkCancellation()
    guard !closed else { throw CancellationError() }
    return value
  }

  func refreshKnown() async {
    guard !closed, !Task.isCancelled else { return }
    // Start independent keys before awaiting, without converting polling into a read.
    let reads = live.values.compactMap(\.value)
    var tasks: [Task<ChatConnectorStatus?, Error>] = []
    for read in reads {
      do {
        if !read.isPending { try read.invalidate(in: store) }
        tasks.append(try store.get(read.value))
      } catch { if !closed { didFail(error) } }
    }
    for task in tasks { _ = await task.result }
  }

  func invalidate(_ action: ChatConnectorAction) {
    guard !closed, let read = live[Key(action)]?.value else { return }
    do { try read.invalidate(in: store) } catch { didFail(error) }
  }

  fileprivate func started(_ read: ConnectorActionStatusRead) { pending[read.key] = read }

  fileprivate func finished(_ read: ConnectorActionStatusRead) {
    if pending[read.key] === read { pending[read.key] = nil }
  }

  fileprivate func load(_ action: ChatConnectorAction) async throws -> ChatConnectorStatus? {
    try Task.checkCancellation()
    guard !closed else { throw CancellationError() }
    let result = try await service.status(action)
    try Task.checkCancellation()
    guard !closed else { throw CancellationError() }
    return result
  }

  fileprivate func failed(_ error: Error) {
    if !closed { didFail(error) }
  }

  func close() {
    guard !closed else { return }
    closed = true
    for read in live.values.compactMap(\.value) { read.cancel() }
    pending = [:]
    recent = []
    live = [:]
    do { try store.set(lifetime, false) } catch { didFail(error) }
  }
}

/// One signal and original Task per normalized read key, including a cached error until retry.
@MainActor
final class ConnectorActionStatusRead {
  let key: ConnectorActionResources.Key
  private let action: ChatConnectorAction
  private weak var owner: ConnectorActionResources?
  private let revision = CCState.State(0)
  private let reload: Command<Void, Void>
  private var request: (id: UUID, task: Task<ChatConnectorStatus?, Error>)?
  private(set) var isPending = false

  fileprivate init(action: ChatConnectorAction, owner: ConnectorActionResources) {
    key = ConnectorActionResources.Key(action)
    self.action = action
    self.owner = owner
    let revision = revision
    reload = Command { context in try context.set(revision, update: { $0 + 1 }) }
  }

  lazy var value = makeValue()

  private func makeValue() -> Computed<Task<ChatConnectorStatus?, Error>> {
    Computed { [weak self] get, options in
      guard let self, let owner, try get(owner.lifetime) else { throw CancellationError() }
      _ = try get(revision)
      let signal = options.signal
      let id = UUID()
      isPending = true
      owner.started(self)
      let task = Task<ChatConnectorStatus?, Error> { @MainActor [weak self, owner, action] in
        defer {
          if let self, request?.id == id {
            isPending = false
            owner.finished(self)
          }
        }
        do {
          let result = try await owner.load(action)
          try Task.checkCancellation()
          try signal.checkCancellation()
          return result
        } catch {
          try Task.checkCancellation()
          try signal.checkCancellation()
          owner.failed(error)
          throw error
        }
      }
      request = (id, task)
      signal.onCancel { task.cancel() }
      return task
    }
  }

  fileprivate func invalidate(in store: CCState.Store) throws {
    request?.task.cancel()
    try store.set(reload)
  }

  fileprivate func cancel() { request?.task.cancel() }
  isolated deinit { request?.task.cancel() }
}
