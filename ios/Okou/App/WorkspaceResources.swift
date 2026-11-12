import CCState
import ChatData
import Foundation
import OSLog

/// One graph per authenticated workspace; each endpoint has its own cached Task.
@MainActor
final class WorkspaceResources {
  let store = CCState.Store()
  private let lifetime = CCState.State(true)
  private let invalidateReads: Command<Void, Set<ChatInvalidation>>
  let navigation: Computed<Task<[AgentRecord], Error>>
  let reloadNavigation: Command<Void, Void>
  let projectList: Computed<Task<[ChatProject], Error>>
  let reloadProjects: Command<Void, Void>
  private let preference: WorkspaceRead<ModelPreference>
  private let available: WorkspaceRead<AvailableRunModels>
  private let catalog: WorkspaceRead<ModelCatalog>
  private let features: WorkspaceRead<SidebarFeatureSwitches>
  private let agents: WorkspaceRead<[AgentRecord]>
  private let projects: WorkspaceRead<[ChatProject]>
  let configuration: Computed<Task<ChatModelConfiguration, Error>>

  init(
    client: APIClient, sleep: @escaping @Sendable (Duration) async throws -> Void,
    lifecycleTasks: LifecycleTasks? = nil
  ) {
    let lifecycleTasks = lifecycleTasks ?? LifecycleTasks()
    let lifetime = lifetime
    let service = ChatModelService(client: client)
    let preference = WorkspaceRead(
      "model preference", sleep: sleep, lifetime: lifetime, lifecycleTasks: lifecycleTasks,
      read: service.preference)
    let available = WorkspaceRead(
      "available models", sleep: sleep, lifetime: lifetime, lifecycleTasks: lifecycleTasks,
      read: service.availableModels)
    let catalog = WorkspaceRead(
      "model catalog", sleep: sleep, lifetime: lifetime, lifecycleTasks: lifecycleTasks,
      read: service.catalog)
    let features = WorkspaceRead(
      "model feature switches", sleep: sleep, lifetime: lifetime, lifecycleTasks: lifecycleTasks,
      read: service.featureSwitches)
    self.preference = preference
    self.available = available
    self.catalog = catalog
    self.features = features
    let agents = WorkspaceRead<[AgentRecord]>(
      "agents", sleep: sleep, lifetime: lifetime, lifecycleTasks: lifecycleTasks
    ) {
      try await client.request("/api/agents")
    }
    self.agents = agents
    navigation = agents.value
    reloadNavigation = agents.reload
    let projects = WorkspaceRead(
      "Projects", sleep: sleep, lifetime: lifetime, lifecycleTasks: lifecycleTasks,
      read: ChatProjects(client: client).list)
    self.projects = projects
    projectList = projects.value
    reloadProjects = projects.reload
    let preferenceValue = preference.value
    let availableValue = available.value
    let catalogValue = catalog.value
    let featureValue = features.value
    invalidateReads = Command { context, changes in
      guard try context.get(lifetime) else { throw CancellationError() }
      if changes.contains(.reconnected) || changes.contains(.modelPreference) {
        try context.set(preference.reload)
      }
      if changes.contains(.reconnected) || changes.contains(.runModels) {
        try context.set(available.reload)
        try context.set(catalog.reload)
      }
      if changes.contains(.reconnected) { try context.set(features.reload) }
    }
    configuration = computedTask { get, options in
      guard try get(lifetime) else { throw CancellationError() }
      // Collect every dependency and start independent I/O before awaiting any result.
      let preference = try get(preferenceValue)
      let available = try get(availableValue)
      let catalog = try get(catalogValue)
      let features = try get(featureValue)
      let value = try await ChatModelConfiguration(
        preference: preference.value, available: available.value, catalog: catalog.value,
        switches: features.value.effectiveSwitches)
      try Task.checkCancellation()
      try options.signal.checkCancellation()
      return value
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

  func invalidate(_ changes: Set<ChatInvalidation>) throws {
    try store.set(invalidateReads, changes)
  }

  func close() {
    preference.close()
    available.close()
    catalog.close()
    features.close()
    agents.close()
    projects.close()
    do { try store.set(lifetime, false) } catch {
      Logger(subsystem: "ai.okou.ios", category: "WorkspaceResources")
        .error(
          "Cannot notify retired resource observers: \(error.localizedDescription, privacy: .public)"
        )
    }
  }
}

/// The graph owns caching; this small endpoint owner adds retry and cancellation.
@MainActor
private final class WorkspaceRead<Value: Sendable> {
  private let lifecycleTasks: LifecycleTasks
  private let revision = CCState.State(0)
  private let lifetime: CCState.State<Bool>
  private let operation: String
  private let sleep: @Sendable (Duration) async throws -> Void
  private let read: @MainActor () async throws -> Value
  private var task: Task<Value, Error>?
  private var closed = false
  private var failed = false

  init(
    _ operation: String, sleep: @escaping @Sendable (Duration) async throws -> Void,
    lifetime: CCState.State<Bool>, lifecycleTasks: LifecycleTasks,
    read: @escaping @MainActor () async throws -> Value
  ) {
    self.operation = operation
    self.lifecycleTasks = lifecycleTasks
    self.lifetime = lifetime
    self.sleep = sleep
    self.read = read
  }

  lazy var value = Computed<Task<Value, Error>> { [weak self] get, options in
    guard let self, try get(lifetime), !closed else { throw CancellationError() }
    _ = try get(revision)
    failed = false
    let signal = options.signal
    let task = Task.immediate { @MainActor [weak self, operation, sleep, read] in
      do {
        let value = try await ChatReadRecovery.read(operation, sleep: sleep, body: read)
        try Task.checkCancellation()
        try signal.checkCancellation()
        guard self?.closed == false else { throw CancellationError() }
        return value
      } catch {
        if !Task.isCancelled, !signal.isCancelled { self?.failed = true }
        throw error
      }
    }
    lifecycleTasks.track(task)
    self.task = task
    signal.onCancel { task.cancel() }
    return task
  }

  lazy var reload = Command<Void, Void> { [weak self] context in
    guard let self, try context.get(lifetime), !closed else { throw CancellationError() }
    task?.cancel()
    try context.set(revision, update: { $0 + 1 })
  }

  func retryFailed(in store: CCState.Store) throws {
    guard !closed else { throw CancellationError() }
    if failed { try store.set(reload) }
  }

  func close() {
    closed = true
    task?.cancel()
    task = nil
  }

  isolated deinit { task?.cancel() }
}
