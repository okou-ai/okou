import CCState
import ChatData
import Foundation

/// Disposable read caches are independent of the registry's conversation-long mutation ledger.
@MainActor
final class PermissionCardResources {
  private final class Key: NSObject {
    let parts: [String]
    init(_ parts: [String]) { self.parts = parts }
    override var hash: Int { parts.hashValue }
    override func isEqual(_ object: Any?) -> Bool { (object as? Key)?.parts == parts }
  }

  @MainActor private final class Cache<Value: Sendable> {
    private final class WeakRead {
      weak var value: PermissionCardRead<Value>?
      init(_ value: PermissionCardRead<Value>) { self.value = value }
    }

    private let cache: NSCache<Key, PermissionCardRead<Value>> = {
      let cache = NSCache<Key, PermissionCardRead<Value>>()
      cache.countLimit = 64
      return cache
    }()
    private var live: [Key: WeakRead] = [:]
    private var active = false
    private var closed = false

    func read(
      key: Key, didFail: @escaping @MainActor (Error) -> Void,
      load: @escaping @MainActor () async throws -> Value
    ) -> PermissionCardRead<Value> {
      if let read = cache.object(forKey: key) ?? live[key]?.value { return read }
      live = live.filter { $0.value.value != nil }
      let read = PermissionCardRead(active: active, load: load, didFail: didFail)
      if closed {
        read.close()
      } else {
        live[key] = WeakRead(read)
        cache.setObject(read, forKey: key)
      }
      return read
    }

    func activate() {
      guard !closed, !active else { return }
      active = true
      live = live.filter { $0.value.value != nil }
      for read in live.values.compactMap(\.value) { read.activate() }
    }

    func deactivate() {
      active = false
      live = live.filter { $0.value.value != nil }
      for read in live.values.compactMap(\.value) { read.deactivate() }
    }

    func close() {
      closed = true
      active = false
      for read in live.values.compactMap(\.value) { read.close() }
      cache.removeAllObjects()
      live = [:]
    }
  }

  private let singles = Cache<ChatPermissionSnapshot>()
  private let batches = Cache<ChatPermissionBatchSnapshot>()
  private let commands: ChatCommands
  private let didFail: @MainActor (Error) -> Void

  init(commands: ChatCommands, didFail: @escaping @MainActor (Error) -> Void) {
    self.commands = commands
    self.didFail = didFail
  }

  func read(_ action: ChatPermissionAction) -> PermissionCardRead<ChatPermissionSnapshot> {
    // The single endpoint loads the connector's entire metadata/grant set, independently
    // of requested permission, duration, explanatory text and continuation identity.
    singles.read(
      key: Key([action.agentID.lowercased(), action.threadID.lowercased(), action.connectorSlug]),
      didFail: didFail, load: { [commands] in try await commands.permissions.load(action) })
  }

  func read(_ action: ChatPermissionBatchAction) -> PermissionCardRead<ChatPermissionBatchSnapshot>
  {
    batches.read(
      key: Key(
        [action.agentID.lowercased(), action.threadID.lowercased()]
          + action.items.flatMap { [$0.connectorSlug, $0.permission] }),
      didFail: didFail, load: { [commands] in try await commands.batchPermissions.load(action) })
  }

  func activate() {
    singles.activate()
    batches.activate()
  }
  func deactivate() {
    singles.deactivate()
    batches.deactivate()
  }
  func close() {
    singles.close()
    batches.close()
  }
}

/// One original Task per normalized read and detail visit. Row waiters never own its cancellation.
@MainActor
final class PermissionCardRead<Value: Sendable> {
  let store = CCState.Store()
  let requested: Computed<Bool>
  private let available: CCState.State<Bool>
  private let demand = CCState.State(false)
  private let revision = CCState.State(0)
  private let request: Command<Void, Bool>
  private let setAvailability: Command<Void, Bool>
  private let reload: Command<Void, Void>
  private let loadValue: @MainActor () async throws -> Value
  private let didFail: @MainActor (Error) -> Void
  private var current: Task<Value, Error>?
  private var pending: UUID?
  private var active: Bool
  private var closed = false

  fileprivate init(
    active: Bool, load: @escaping @MainActor () async throws -> Value,
    didFail: @escaping @MainActor (Error) -> Void
  ) {
    self.active = active
    available = CCState.State(active)
    loadValue = load
    self.didFail = didFail
    let available = available
    let demand = demand
    let revision = revision
    requested = Computed { get in try get(available) && get(demand) }
    request = Command { context, refresh in
      guard try context.get(available) else { throw CancellationError() }
      if try !context.get(demand) { try context.set(demand, true) }
      if refresh { try context.set(revision, update: { $0 + 1 }) }
    }
    setAvailability = Command { context, active in
      try context.set(available, active)
      if !active { try context.set(demand, false) }
    }
    reload = Command { context in try context.set(revision, update: { $0 + 1 }) }
  }

  lazy var value = makeValue()

  private func makeValue() -> Computed<Task<Value, Error>> {
    Computed { [weak self] get, options in
      guard let self, !closed, try get(available), try get(demand) else {
        throw CancellationError()
      }
      _ = try get(revision)
      let signal = options.signal
      let id = UUID()
      pending = id
      let task = Task<Value, Error> { @MainActor [self] in
        defer { if pending == id { pending = nil } }
        do {
          try Task.checkCancellation()
          let result = try await loadValue()
          try Task.checkCancellation()
          try signal.checkCancellation()
          guard active, !closed else { throw CancellationError() }
          return result
        } catch {
          if active, !closed, !Task.isCancelled, !signal.isCancelled { didFail(error) }
          throw error
        }
      }
      current = task
      signal.onCancel { task.cancel() }
      return task
    }
  }

  func load(refresh: Bool = false) async throws -> Value {
    guard active, !closed, !Task.isCancelled else { throw CancellationError() }
    try store.set(request, refresh && pending == nil)
    var task = try store.get(value)
    while active, !closed {
      let result = await task.result
      try Task.checkCancellation()
      guard active, !closed else { throw CancellationError() }
      let latest = try store.get(value)
      if task != latest {
        task = latest
        continue
      }
      return try result.get()
    }
    throw CancellationError()
  }

  /// Mutation completion invalidates only the repeatable read, never its write or callback.
  func invalidate() {
    guard active, !closed else { return }
    current?.cancel()
    pending = nil
    do { try store.set(reload) } catch {
      preconditionFailure("Cannot invalidate local permission inputs: \(error)")
    }
  }

  fileprivate func activate() {
    guard !active, !closed else { return }
    active = true
    do { try store.set(setAvailability, true) } catch {
      preconditionFailure("Cannot activate local permission inputs: \(error)")
    }
  }

  fileprivate func deactivate() {
    active = false
    current?.cancel()
    current = nil
    pending = nil
    do { try store.set(setAvailability, false) } catch {
      preconditionFailure("Cannot retire local permission inputs: \(error)")
    }
  }

  fileprivate func close() {
    closed = true
    deactivate()
  }

  isolated deinit { current?.cancel() }
}
