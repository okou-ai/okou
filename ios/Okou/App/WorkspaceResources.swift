import CCState
import ChatData
import Foundation

/// One graph per authenticated workspace; each endpoint has its own cached Task.
@MainActor
final class WorkspaceResources {
  let store = CCState.Store()
  private let preference: WorkspaceRead<ModelPreference>
  private let available: WorkspaceRead<AvailableRunModels>
  private let catalog: WorkspaceRead<ModelCatalog>
  private let features: WorkspaceRead<SidebarFeatureSwitches>
  private let agents: WorkspaceRead<[AgentRecord]>
  private let projects: WorkspaceRead<[ChatProject]>
  let configuration: Computed<Task<ChatModelConfiguration, Error>>
  let projectListValue: Computed<Task<[ChatProject], Error>>
  private let projectLifetime = CCState.State(true)
  private let reloadProjects: Command<Void, Void>
  private let retireProjects: Command<Void, Void>

  init(client: APIClient, sleep: @escaping @Sendable (Duration) async throws -> Void) {
    let service = ChatModelService(client: client)
    let preference = WorkspaceRead("model preference", sleep: sleep, read: service.preference)
    let available = WorkspaceRead("available models", sleep: sleep, read: service.availableModels)
    let catalog = WorkspaceRead("model catalog", sleep: sleep, read: service.catalog)
    let features = WorkspaceRead(
      "model feature switches", sleep: sleep, read: service.featureSwitches)
    self.preference = preference
    self.available = available
    self.catalog = catalog
    self.features = features
    agents = WorkspaceRead("agents", sleep: sleep) { try await client.request("/api/agents") }
    let projects = WorkspaceRead("Projects", sleep: sleep, read: ChatProjects(client: client).list)
    self.projects = projects
    let projectLifetime = projectLifetime
    projectListValue = Computed { get in
      guard try get(projectLifetime) else { throw CancellationError() }
      // Expose the original endpoint Task, without a second async/loading wrapper.
      return try get(projects.value)
    }
    reloadProjects = Command { context in
      guard try context.get(projectLifetime) else { throw CancellationError() }
      try context.set(projects.revision, update: { $0 + 1 })
    }
    retireProjects = Command { context in try context.set(projectLifetime, false) }
    let preferenceValue = preference.value
    let availableValue = available.value
    let catalogValue = catalog.value
    let featureValue = features.value
    configuration = computedTask { get, _ in
      // Collect every dependency and start independent I/O before awaiting any result.
      let preference = try get(preferenceValue)
      let available = try get(availableValue)
      let catalog = try get(catalogValue)
      let features = try get(featureValue)
      return try await ChatModelConfiguration(
        preference: preference.value, available: available.value, catalog: catalog.value,
        switches: features.value.effectiveSwitches)
    }
  }

  func load() throws -> Task<ChatModelConfiguration, Error> {
    try preference.retryFailed(in: store)
    try available.retryFailed(in: store)
    try catalog.retryFailed(in: store)
    try features.retryFailed(in: store)
    return try store.get(configuration)
  }
  func loadCatalog() throws -> Task<ModelCatalog, Error> {
    try catalog.retryFailed(in: store)
    return try store.get(catalog.value)
  }

  func navigation(refresh: Bool) throws -> Task<[AgentRecord], Error> {
    if refresh { try store.set(agents.revision, update: { $0 + 1 }) }
    try agents.retryFailed(in: store)
    return try store.get(agents.value)
  }

  /// The resource reports phase/error; this sink owns only business confirmation.
  func bindProjects(
    confirm: @escaping @MainActor ([ChatProject]) async throws -> Void,
    didFail: @escaping @MainActor (Error) -> Void
  ) {
    projects.confirm = confirm
    projects.didFail = didFail
  }

  func cancelProjectRead() { projects.cancel() }

  func refreshProjects() throws {
    projects.cancel()
    try store.set(reloadProjects)
  }

  func closeProjects() throws {
    projects.close()
    try store.set(retireProjects)
  }

  func invalidate(_ changes: Set<ChatInvalidation>) throws {
    let reload = Command<Void, Void> { context in
      if changes.contains(.reconnected) || changes.contains(.modelPreference) {
        try context.set(self.preference.revision, update: { $0 + 1 })
      }
      if changes.contains(.reconnected) || changes.contains(.runModels) {
        try context.set(self.available.revision, update: { $0 + 1 })
        try context.set(self.catalog.revision, update: { $0 + 1 })
      }
      if changes.contains(.reconnected) {
        try context.set(self.features.revision, update: { $0 + 1 })
      }
    }
    try store.set(reload)
  }

  func close() {
    preference.close()
    available.close()
    catalog.close()
    features.close()
    agents.close()
    // This command writes only a local lifetime atom; it cannot perform external I/O.
    do { try closeProjects() } catch {
      preconditionFailure("Cannot retire the workspace Project graph: \(error)")
    }
  }
}

/// The graph owns caching; this small endpoint owner adds retry and cancellation.
@MainActor
private final class WorkspaceRead<Value: Sendable> {
  let revision = CCState.State(0)
  private let operation: String
  private let sleep: @Sendable (Duration) async throws -> Void
  private let read: @MainActor () async throws -> Value
  var confirm: (@MainActor (Value) async throws -> Void)?
  var didFail: (@MainActor (Error) -> Void)?
  private var task: Task<Value, Error>?
  private var closed = false
  private var failed = false

  init(
    _ operation: String, sleep: @escaping @Sendable (Duration) async throws -> Void,
    read: @escaping @MainActor () async throws -> Value
  ) {
    self.operation = operation
    self.sleep = sleep
    self.read = read
  }

  lazy var value = Computed<Task<Value, Error>> { [weak self] get, options in
    guard let self, !closed else { throw CancellationError() }
    _ = try get(revision)
    failed = false
    let signal = options.signal
    let task = Task.immediate { @MainActor [weak self, operation, sleep, read] in
      do {
        let result = try await ChatReadRecovery.read(operation, sleep: sleep, body: read)
        try Task.checkCancellation()
        try signal.checkCancellation()
        guard let self, !closed else { throw CancellationError() }
        try await confirm?(result)
        try Task.checkCancellation()
        try signal.checkCancellation()
        return result
      } catch {
        if let self, !closed, !Task.isCancelled, !signal.isCancelled {
          failed = true
          didFail?(error)
        }
        throw error
      }
    }
    self.task = task
    signal.onCancel { task.cancel() }
    return task
  }

  func retryFailed(in store: CCState.Store) throws {
    if failed { try store.set(revision, update: { $0 + 1 }) }
  }

  func cancel() { task?.cancel() }

  func close() {
    closed = true
    task?.cancel()
    task = nil
    confirm = nil
    didFail = nil
  }

  isolated deinit { task?.cancel() }
}
