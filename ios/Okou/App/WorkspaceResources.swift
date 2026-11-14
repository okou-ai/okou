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
  private let modelBootstrap: WorkspaceModelBootstrap?
  let navigation: Computed<Task<[AgentRecord], Error>>
  let reloadNavigation: Command<Void, Void>
  let projectList: Computed<Task<[ChatProject], Error>>
  let reloadProjects: Command<Void, Void>
  let sidebarDraftThreadIDs: Computed<Task<Set<String>, Error>>
  let reloadSidebarDrafts: Command<Void, Void>
  private let preference: WorkspaceRead<ModelPreference>
  private let available: WorkspaceRead<AvailableRunModels>
  private let catalog: WorkspaceRead<ModelCatalog>
  private let features: WorkspaceRead<SidebarFeatureSwitches>
  private let agents: WorkspaceRead<[AgentRecord]>
  private let projects: WorkspaceRead<[ChatProject]>
  private let sidebarDrafts: WorkspaceRead<Set<String>>
  private let billing: WorkspaceRead<WorkspaceBilling>
  let billingValue: Computed<Task<WorkspaceBilling, Error>>
  let configuration: Computed<Task<ChatModelConfiguration, Error>>

  init(
    client: APIClient, sync: ChatSync, sleep: @escaping @Sendable (Duration) async throws -> Void,
    modelBootstrap: WorkspaceModelBootstrap? = nil,
    lifecycleTasks: LifecycleTasks? = nil
  ) {
    self.modelBootstrap = modelBootstrap
    let lifecycleTasks = lifecycleTasks ?? LifecycleTasks()
    let lifetime = lifetime
    let modelReadiness: (@MainActor () async throws -> Void)?
    if let modelBootstrap {
      modelReadiness = { try await modelBootstrap.wait() }
    } else {
      modelReadiness = nil
    }
    let service = ChatModelService(client: client)
    let preference = WorkspaceRead(
      "model preference", sleep: sleep, lifetime: lifetime, lifecycleTasks: lifecycleTasks,
      readiness: modelReadiness, read: service.preference)
    let available = WorkspaceRead(
      "available models", sleep: sleep, lifetime: lifetime, lifecycleTasks: lifecycleTasks,
      readiness: modelReadiness, read: service.availableModels)
    let catalog = WorkspaceRead(
      "model catalog", sleep: sleep, lifetime: lifetime, lifecycleTasks: lifecycleTasks,
      readiness: modelReadiness, read: service.catalog)
    let features = WorkspaceRead(
      "model feature switches", sleep: sleep, lifetime: lifetime, lifecycleTasks: lifecycleTasks,
      readiness: modelReadiness, read: service.featureSwitches)
    self.preference = preference
    self.available = available
    self.catalog = catalog
    self.features = features
    let billing = WorkspaceRead(
      "billing", sleep: sleep, lifetime: lifetime, lifecycleTasks: lifecycleTasks,
      read: WorkspaceBillingService(client: client).status)
    self.billing = billing
    billingValue = billing.value
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
      read: sync.projectList)
    self.projects = projects
    projectList = projects.value
    reloadProjects = projects.reload
    let sidebarDrafts = WorkspaceRead(
      "sidebar drafts", sleep: sleep, lifetime: lifetime, lifecycleTasks: lifecycleTasks,
      read: ChatDraftRepository(client: client).threadIDs)
    self.sidebarDrafts = sidebarDrafts
    sidebarDraftThreadIDs = sidebarDrafts.value
    reloadSidebarDrafts = sidebarDrafts.reload
    let preferenceValue = preference.value
    let availableValue = available.value
    let catalogValue = catalog.value
    let featureValue = features.value
    invalidateReads = Command { context, changes in
      guard try context.get(lifetime) else { throw CancellationError() }
      var full = changes.contains(.reconnected)
      if changes.contains(.startup) {
        full = (modelBootstrap?.beginStartup() ?? true) || full
      }
      if changes.contains(.initialSubscriptions) {
        full = (modelBootstrap?.subscriptionsReady() ?? true) || full
      }
      if changes.contains(where: \.coordinatesModelRecovery) {
        full = (modelBootstrap?.needsRecoveryRead ?? true) || full
      }
      if full { modelBootstrap?.didScheduleRead() }
      if full || changes.contains(.modelPreference) {
        try context.set(preference.reload)
      }
      if full || changes.contains(.runModels) {
        try context.set(available.reload)
        try context.set(catalog.reload)
      }
      if full { try context.set(features.reload) }
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

  func retrySidebarDrafts() throws {
    try sidebarDrafts.retryFailed(in: store)
  }

  func prepareSettings() throws {
    try store.set(billing.reload)
  }

  func loadSettingsBilling() async throws {
    try Task.checkCancellation()
    guard try store.get(lifetime) else { throw CancellationError() }
    try billing.retryFailed(in: store)
    _ = try await store.get(billingValue).value
  }

  func close() {
    modelBootstrap?.close()
    preference.close()
    available.close()
    catalog.close()
    features.close()
    agents.close()
    projects.close()
    sidebarDrafts.close()
    billing.close()
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
  private let readiness: (@MainActor () async throws -> Void)?
  private let operation: String
  private let sleep: @Sendable (Duration) async throws -> Void
  private let read: @MainActor () async throws -> Value
  private var task: Task<Value, Error>?
  private var closed = false
  private var failed = false

  init(
    _ operation: String, sleep: @escaping @Sendable (Duration) async throws -> Void,
    lifetime: CCState.State<Bool>, lifecycleTasks: LifecycleTasks,
    readiness: (@MainActor () async throws -> Void)? = nil,
    read: @escaping @MainActor () async throws -> Value
  ) {
    self.operation = operation
    self.lifecycleTasks = lifecycleTasks
    self.lifetime = lifetime
    self.readiness = readiness
    self.sleep = sleep
    self.read = read
  }

  lazy var value = Computed<Task<Value, Error>> { [weak self] get, options in
    guard let self, try get(lifetime), !closed else { throw CancellationError() }
    _ = try get(revision)
    let readiness = readiness
    failed = false
    let signal = options.signal
    let task = Task.immediate { @MainActor [weak self, operation, sleep, read, readiness] in
      do {
        try await readiness?()
        try Task.checkCancellation()
        try signal.checkCancellation()
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
