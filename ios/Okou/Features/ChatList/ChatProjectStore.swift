import CCState
import ChatData
import Foundation
import Observation

/// Confirmed Project names, membership operations and native list disclosure for one workspace.
@MainActor @Observable
final class ChatProjectStore {
  private(set) var projects: [ChatProject] = []
  private(set) var active = false
  private(set) var actionError: String?
  private(set) var pending: Set<String> = []
  private(set) var expansion: [String: Bool] = [:]
  private(set) var limits: [String: Int] = [:]
  private let service: ChatProjects
  let stateStore = CCState.Store()
  private let readRevision = CCState.State(0)
  private let lifetime = CCState.State(true)
  private let reload: Command<Void, Void>
  private let sleep: @Sendable (Duration) async throws -> Void
  private let sync: ChatSync
  private let didFail: @MainActor (Error) -> Void
  private let didDelete: @MainActor (String) -> Void
  private let didChangeMembership: @MainActor () async -> Void
  private var readTask: Task<[ChatProject], Error>?
  private var persistenceTask: Task<Void, Never>?
  private var persistenceID = UUID()
  private var hasConfirmedSnapshot = false
  private var tasks: [String: Task<Void, Never>] = [:]
  private var operations: [String: (payload: String, id: String)] = [:]
  private var revision = 0
  private var closed = false
  private var blocked = false
  private var expansionKey: String?
  private let defaults: UserDefaults

  init(
    client: APIClient, sync: ChatSync,
    defaults: UserDefaults = .standard,
    sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
    didFail: @escaping @MainActor (Error) -> Void,
    didDelete: @escaping @MainActor (String) -> Void = { _ in },
    didChangeMembership: @escaping @MainActor () async -> Void
  ) {
    service = ChatProjects(client: client)
    self.sleep = sleep
    self.sync = sync
    self.defaults = defaults
    self.didDelete = didDelete
    self.didFail = didFail
    self.didChangeMembership = didChangeMembership
    let readRevision = readRevision
    let lifetime = lifetime
    reload = Command { context in
      guard try context.get(lifetime) else { throw CancellationError() }
      try context.set(readRevision, update: { $0 + 1 })
    }
  }

  func restore(userID: String, workspaceID: String, apiURL: URL) async {
    guard !closed else { return }
    let key = "project-expansion:\(apiURL.absoluteString):\(userID):\(workspaceID)"
    if expansionKey != key {
      expansionKey = key
      expansion = defaults.dictionary(forKey: key) as? [String: Bool] ?? [:]
    }
    let previous = revision
    if !hasConfirmedSnapshot, let cached = await sync.cachedProjects(), !closed,
      previous == revision, !hasConfirmedSnapshot
    {
      projects = cached
      hasConfirmedSnapshot = true
    }
  }

  func isExpanded(_ id: String) -> Bool { expansion[id] ?? false }
  func limit(for id: String) -> Int { limits[id] ?? 20 }

  func showMore(_ id: String) {
    guard !closed else { return }
    limits[id] = limit(for: id) + 20
  }

  func activate() async {
    guard !active, !closed else { return }
    active = true
    await load()
  }

  func toggle(_ id: String) {
    guard !closed else { return }
    expansion[id] = !isExpanded(id)
    persistExpansion()
  }

  func expand(_ id: String) {
    guard !closed else { return }
    expansion[id] = true
    persistExpansion()
  }

  private func persistExpansion() {
    if let expansionKey { defaults.set(expansion, forKey: expansionKey) }
  }

  /// The original workspace-lived read Task owns phase/error. `projects` is separately
  /// confirmed for mutation reconciliation, new-chat context and durable restoration.
  @ObservationIgnored lazy var value = Computed<Task<[ChatProject], Error>> {
    [weak self] get, options in
    guard let self, try get(lifetime), !closed else { throw CancellationError() }
    _ = try get(readRevision)
    let previous = revision
    let signal = options.signal
    let task = Task.immediate { @MainActor [weak self, service, sleep] in
      guard let self else { throw CancellationError() }
      do {
        let result = try await ChatReadRecovery.read("Projects", sleep: sleep, body: service.list)
        try Task.checkCancellation()
        try signal.checkCancellation()
        guard !closed, previous == revision else { throw CancellationError() }
        projects = result
        hasConfirmedSnapshot = true
        let knownIDs = Set(result.map(\.id))
        expansion = expansion.filter { knownIDs.contains($0.key) }
        limits = limits.filter { knownIDs.contains($0.key) }
        persistExpansion()
        await persistConfirmed()
        try Task.checkCancellation()
        try signal.checkCancellation()
        return result
      } catch {
        if !closed, !Task.isCancelled, !signal.isCancelled {
          blocked = (error as? APIClientError)?.statusCode == 426
          didFail(error)
        }
        throw error
      }
    }
    readTask = task
    signal.onCancel { task.cancel() }
    return task
  }

  private func invalidateRead() throws {
    readTask?.cancel()
    try stateStore.set(reload)
  }

  private func load() async {
    guard !closed, !blocked, !Task.isCancelled else { return }
    do {
      // Awaiting a shared Task does not transfer I/O ownership to a UI waiter.
      _ = await (try stateStore.get(value)).result
    } catch { didFail(error) }
  }

  func refresh() async {
    guard !closed, !blocked, !Task.isCancelled else { return }
    do { try invalidateRead() } catch { didFail(error) }
    await load()
  }

  /// Serialize confirmed snapshots, including writes that overlap a suspended read.
  /// Already confirmed persistence may finish after close, only in its original cache scope.
  private func persistConfirmed() async {
    let previous = persistenceTask
    let snapshot = projects
    let id = UUID()
    persistenceID = id
    let task = Task { [sync] in
      await previous?.value
      await sync.persistProjects(snapshot)
    }
    persistenceTask = task
    await task.value
    if persistenceID == id { persistenceTask = nil }
  }

  @discardableResult
  func create(name: String, fromThreadID: String? = nil) async -> ChatProject? {
    let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty, name.utf16.count <= 120 else { return nil }
    let project = await mutate(key: "create", payload: "\(name):\(fromThreadID ?? "")") {
      [service] eventID in
      try await service.create(name: name, eventID: eventID, fromThreadID: fromThreadID)
    } confirm: { [self] project in
      if !projects.contains(where: { $0.id == project.id }) { projects.append(project) }
      hasConfirmedSnapshot = true
      expand(project.id)
      await persistConfirmed()
      if fromThreadID != nil { await didChangeMembership() }
    }
    return project
  }

  @discardableResult
  func rename(_ id: String, name: String) async -> Bool {
    let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty, name.utf16.count <= 120 else { return false }
    let project = await mutate(key: id, payload: "rename:\(name)") { [service] eventID in
      try await service.rename(id, name: name, eventID: eventID)
    } confirm: { [self] project in
      if let index = projects.firstIndex(where: { $0.id == id }) { projects[index] = project }
      await persistConfirmed()
    }
    return project != nil
  }

  @discardableResult
  func delete(_ id: String) async -> Bool {
    let result = await mutate(key: id, payload: "delete") { [service] eventID in
      try await service.delete(id, eventID: eventID)
    } confirm: { [self] _ in
      projects.removeAll { $0.id == id }
      didDelete(id)
      expansion[id] = nil
      limits[id] = nil
      persistExpansion()
      await persistConfirmed()
      await didChangeMembership()
    }
    return result != nil
  }

  @discardableResult
  func move(threadID: String, projectID: String?) async -> Bool {
    let result = await mutate(key: threadID, readback: false, payload: "move:\(projectID ?? "")") {
      [service] eventID in
      try await service.move(threadID: threadID, projectID: projectID, eventID: eventID)
    } confirm: { [self] _ in
      if let projectID { expand(projectID) }
      await didChangeMembership()
    }
    return result != nil
  }

  /// Failed explicit retries retain their operation identity; a changed intent gets a new one.
  private func mutate<Value: Sendable>(
    key: String, readback: Bool = true, payload: String,
    body: @escaping @MainActor (String) async throws -> Value,
    confirm: @escaping @MainActor (Value) async -> Void
  ) async -> Value? {
    guard !closed, !blocked, !pending.contains(key), !Task.isCancelled else { return nil }
    let previous = operations[key]
    let id: String
    if let previous, previous.payload == payload {
      id = previous.id
    } else {
      id = ChatProjects.operationID()
    }
    operations[key] = (payload, id)
    pending.insert(key)
    if readback {
      revision += 1
      readTask?.cancel()
    }
    var result: Value?
    let task = Task { [weak self] in
      guard let self else { return }
      defer {
        pending.remove(key)
        tasks[key] = nil
      }
      do {
        let value = try await body(id)
        try Task.checkCancellation()
        guard !closed else { return }
        if readback { revision += 1 }
        operations[key] = nil
        actionError = nil
        // The operation owns confirmation and persistence even if its UI waiter leaves.
        await confirm(value)
        guard !closed else { return }
        result = value
      } catch is CancellationError {
      } catch {
        guard !closed, !Task.isCancelled else { return }
        actionError = error.localizedDescription
        blocked = (error as? APIClientError)?.statusCode == 426
        didFail(error)
      }
      if readback { await refresh() }
    }
    tasks[key] = task
    await task.value
    return result
  }

  func dismissError() { actionError = nil }

  func close() {
    guard !closed else { return }
    closed = true
    readTask?.cancel()
    readTask = nil
    do { try stateStore.set(lifetime, false) } catch { didFail(error) }
    for task in tasks.values { task.cancel() }
  }

  isolated deinit {
    readTask?.cancel()
    for task in tasks.values { task.cancel() }
  }
}
