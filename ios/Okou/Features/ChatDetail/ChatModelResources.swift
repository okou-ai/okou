import CCState
import ChatData
import Foundation

/// One graph per authenticated workspace; each endpoint has its own cached Task.
@MainActor
final class ChatModelResources {
  private let store = CCState.Store()
  private let preference: ModelRead<ModelPreference>
  private let available: ModelRead<AvailableRunModels>
  private let catalog: ModelRead<ModelCatalog>
  private let features: ModelRead<SidebarFeatureSwitches>
  private let configuration: Computed<Task<ChatModelConfiguration, Error>>

  init(service: ChatModelService, sleep: @escaping @Sendable (Duration) async throws -> Void) {
    let preference = ModelRead("model preference", sleep: sleep, read: service.preference)
    let available = ModelRead("available models", sleep: sleep, read: service.availableModels)
    let catalog = ModelRead("model catalog", sleep: sleep, read: service.catalog)
    let features = ModelRead("model feature switches", sleep: sleep, read: service.featureSwitches)
    self.preference = preference
    self.available = available
    self.catalog = catalog
    self.features = features
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
  }
}

/// The graph owns caching; this small endpoint owner adds retry and cancellation.
@MainActor
private final class ModelRead<Value: Sendable> {
  let revision = CCState.State(0)
  private let operation: String
  private let sleep: @Sendable (Duration) async throws -> Void
  private let read: @MainActor () async throws -> Value
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
    let task = Task.immediate { @MainActor [weak self, operation, sleep, read] in
      do {
        return try await ChatReadRecovery.read(operation, sleep: sleep, body: read)
      } catch {
        if !Task.isCancelled { self?.failed = true }
        throw error
      }
    }
    self.task = task
    options.signal.onCancel { task.cancel() }
    return task
  }

  func retryFailed(in store: CCState.Store) throws {
    if failed { try store.set(revision, update: { $0 + 1 }) }
  }

  func close() {
    closed = true
    task?.cancel()
    task = nil
  }

  isolated deinit { task?.cancel() }
}
