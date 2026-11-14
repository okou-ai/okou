import CCState
import ChatData
import ChatDomain
import Foundation
import Observation

/// Shared model metadata has one owner per authenticated workspace. Quota reads are separate.
@MainActor @Observable
final class ChatModelStore {
  let webURL: URL
  let service: ChatModelService
  let connectorAccess: ChatComposerAccess
  let connectorAuthorization: ChatConnectorService
  let subscriptions: PersonalSubscriptionStore
  private(set) var configuration: ChatModelConfiguration?
  private(set) var active = false
  private var closed = false
  private var reportingCatalog: ModelCatalog?
  @ObservationIgnored private var publication: Task<ChatModelConfiguration, Error>?
  private let lifetime = CCState.State(true)
  private let resources: WorkspaceResources
  private let ownsResources: Bool
  let readRetrySleep: @Sendable (Duration) async throws -> Void
  private let didFail: @MainActor (Error) -> Void

  init(
    client: APIClient, webURL: URL, resources: WorkspaceResources? = nil,
    readRetrySleep: @escaping @Sendable (Duration) async throws -> Void = {
      try await Task.sleep(for: $0)
    },
    didFail: @escaping @MainActor (Error) -> Void
  ) {
    self.readRetrySleep = readRetrySleep
    self.webURL = webURL
    let service = ChatModelService(client: client)
    self.service = service
    self.resources =
      resources
      ?? WorkspaceResources(client: client, sync: ChatSync(client: client), sleep: readRetrySleep)
    ownsResources = resources == nil
    connectorAccess = ChatComposerAccess(client: client)
    connectorAuthorization = ChatConnectorService(client: client)
    subscriptions = PersonalSubscriptionStore(
      client: client, stateStore: self.resources.store, didFail: didFail)
    self.didFail = didFail
    // Connecting a subscription can also change the server's default model.
    subscriptions.didMutate = { [weak self] in
      await self?.refresh([.runModels, .modelPreference])
    }
  }

  var stateStore: CCState.Store { resources.store }

  /// The graph owns the request and publishes one confirmed snapshot for send admission.
  /// Views observe this Task directly; they do not mirror its loading or error state here.
  @ObservationIgnored lazy var configurationValue = Computed<Task<ChatModelConfiguration, Error>> {
    [weak self] get, options in
    guard let self, try get(lifetime), !closed else { throw CancellationError() }
    let pending = try get(resources.configuration)
    let signal = options.signal
    let task = Task.immediate { @MainActor [weak self] in
      do {
        let value = try await pending.value
        try signal.checkCancellation()
        try Task.checkCancellation()
        guard let self, !closed else { throw CancellationError() }
        configuration = value
        return value
      } catch {
        if !Task.isCancelled, !signal.isCancelled { self?.report(error) }
        throw error
      }
    }
    publication = task
    signal.onCancel { task.cancel() }
    return task
  }

  /// Non-view consumers await the same graph Task as every SwiftUI subscriber.
  func load() async {
    guard !closed, !Task.isCancelled else { return }
    active = true
    do {
      _ = try resources.load()
      let task = try stateStore.get(configurationValue)
      // The graph reports a failure once; every consumer can inspect the original result.
      _ = await task.result
    } catch is CancellationError {
    } catch { report(error) }
  }

  func refresh(_ changes: Set<ChatInvalidation> = [.reconnected]) async {
    guard !closed, !Task.isCancelled else { return }
    do {
      try resources.invalidate(changes)
    } catch {
      report(error)
      return
    }
    await load()
  }

  var usageCatalog: ModelCatalog? { configuration?.catalog ?? reportingCatalog }

  /// Reporting needs model names even when the model picker has never opened.
  /// This read does not activate model selection or load subscription quotas.
  func loadUsageCatalog() async {
    guard !closed, !Task.isCancelled, usageCatalog == nil else { return }
    do {
      let result = try await resources.loadCatalog().value
      guard !closed, !Task.isCancelled else { return }
      reportingCatalog = result
    } catch is CancellationError {
    } catch {
      guard !closed, !Task.isCancelled else { return }
      didFail(error)
    }
  }
  func report(_ failure: Error) {
    guard !closed else { return }
    didFail(failure)
  }
  func applyPreference(_ preference: ModelPreference) {
    guard !closed, let configuration else { return }
    publication?.cancel()
    self.configuration = configuration.withPreference(preference)
  }
  func close() {
    closed = true
    publication?.cancel()
    publication = nil
    configuration = nil
    do { try stateStore.set(lifetime, false) } catch { didFail(error) }
    if ownsResources { resources.close() }
    reportingCatalog = nil
    subscriptions.close()
  }

  isolated deinit { publication?.cancel() }
}

/// Changes commit before becoming sendable. Opening a sheet only reads metadata.
@MainActor @Observable
final class ChatModelSelectionStore {
  let models: ChatModelStore
  let threadID: String?
  let connectors: ComposerConnectorStore
  private var stored: ChatModelSelection?
  private(set) var isSaving = false
  private(set) var hasLoaded: Bool
  // Mutation outcomes only; metadata read failures remain on the original graph Task.
  private(set) var error: String?
  private(set) var uncertain = false
  private(set) var needsThreadReadback = false
  var isSending = false
  private var refreshAfterSave = false
  private var closed = false
  private let lifecycleTasks: LifecycleTasks
  @ObservationIgnored private let metadataDemand = CCState.State<UUID?>(nil)
  @ObservationIgnored private let lifetime = CCState.State(true)
  @ObservationIgnored private let reloadMetadata: Command<Void, Void>
  @ObservationIgnored private let clearMetadata: Command<Void, Void>
  // The original request also excludes writes until metadata confirmation finishes.
  private var metadataTask: Task<ChatModelSelection?, Error>?
  private var metadataID: UUID?

  init(
    models: ChatModelStore, thread: ChatThread? = nil, lifecycleTasks: LifecycleTasks? = nil
  ) {
    self.models = models
    self.lifecycleTasks = lifecycleTasks ?? LifecycleTasks()
    let metadataDemand = metadataDemand
    let lifetime = lifetime
    reloadMetadata = Command { context in
      guard try context.get(lifetime) else { throw CancellationError() }
      try context.set(metadataDemand, UUID())
    }
    clearMetadata = Command { context in try context.set(metadataDemand, nil) }
    connectors = ComposerConnectorStore(
      service: models.connectorAccess, authorizationService: models.connectorAuthorization,
      webURL: models.webURL, thread: thread, readRetrySleep: models.readRetrySleep,
      didFail: models.report)
    threadID = thread?.id
    stored = thread.map(ChatModelSelection.init)
    hasLoaded = thread == nil
  }

  /// The sheet, composer and background callers observe one conversation-scoped read.
  /// No demand means no metadata I/O, including for an unsent new chat.
  @ObservationIgnored lazy var metadataValue = makeMetadataValue()

  private func makeMetadataValue() -> Computed<Task<ChatModelSelection?, Error>> {
    Computed {
      [weak self] get, options in
      guard let self, !closed, try get(lifetime) else { throw CancellationError() }
      let demand = try get(metadataDemand)
      let signal = options.signal
      let task = Task<ChatModelSelection?, Error> {
        @MainActor [weak self, service = models.service, sleep = models.readRetrySleep, threadID] in
        try Task.checkCancellation()
        try signal.checkCancellation()
        guard let self, !closed else { throw CancellationError() }
        guard let demand, let threadID else { return nil }
        defer {
          if metadataID == demand {
            metadataTask = nil
            metadataID = nil
          }
        }
        do {
          let value = try await ChatReadRecovery.read("saved model selection", sleep: sleep) {
            try await service.selection(threadID: threadID)
          }
          try Task.checkCancellation()
          try signal.checkCancellation()
          guard !closed else { throw CancellationError() }
          // This confirmed snapshot is also consumed by send admission and draft capture.
          stored = value
          hasLoaded = true
          uncertain = false
          needsThreadReadback = false
          error = nil
          return value
        } catch {
          if !closed, !Task.isCancelled, !signal.isCancelled {
            uncertain = true
            models.report(error)
          }
          throw error
        }
      }
      lifecycleTasks.track(task)
      if let demand {
        metadataTask?.cancel()
        metadataTask = task
        metadataID = demand
      }
      signal.onCancel { task.cancel() }
      return task
    }
  }

  var isRefreshing: Bool { metadataTask != nil }
  var selection: ChatModelSelection {
    let selection = stored ?? models.configuration?.defaultSelection ?? ChatModelSelection()
    return models.configuration?.resolved(selection) ?? selection
  }
  var modelsWebURL: URL {
    models.webURL.appending(queryItems: [
      URLQueryItem(name: "settings", value: "billing"),
      URLQueryItem(name: "billingView", value: "plans"),
    ])
  }
  var isMutating: Bool { isSaving || isSending }
  var isBusy: Bool { isMutating || isRefreshing }
  var canSend: Bool { !isRefreshing && canSendConfirmedSelection }
  /// Background reads do not invalidate the selection already confirmed for recovery.
  var canSendConfirmedSelection: Bool {
    guard connectors.canSend else { return false }
    guard models.active else { return true }
    guard models.configuration != nil else { return false }
    return !isSaving && hasLoaded && !uncertain
      && models.configuration?.row(for: selection)?.memberEffective.availability == "available"
  }
  var effectiveEffort: String? { models.configuration?.effectiveEffort(for: selection) }
  var requestedEffort: String? { models.configuration?.requestedEffort(for: selection) }
  var canSaveForFutureChats: Bool { canSaveForFutureChats(selection) }
  /// Whether `choice` (this new chat's choice, or the sheet's draft of it) differs from the
  /// default for new chats, so saving it as that default would change something.
  func canSaveForFutureChats(_ choice: ChatModelSelection) -> Bool {
    guard !closed, threadID == nil, let configuration = models.configuration else { return false }
    let current = configuration.resolved(choice)
    let defaultSelection = configuration.defaultSelection
    // Compare the preferred effort, preserving choices narrowed by the current runtime.
    // Settings remembered for other models do not change this chat's selection.
    func preferredEffort(_ value: ChatModelSelection) -> String? {
      value.model.flatMap { value.modelSettings[$0]?.effort }
        ?? configuration.effectiveEffort(for: value)
    }
    return current.model != defaultSelection.model
      || current.serviceTier != defaultSelection.serviceTier
      || preferredEffort(current) != preferredEffort(defaultSelection)
  }

  func apply(thread: ChatThread, replacing previous: ChatThread) {
    guard !closed, thread.id == threadID else { return }
    if isSaving {
      refreshAfterSave = true
      return
    }
    // An ambiguous local write still needs its explicit metadata readback.
    guard !uncertain else { return }
    retireMetadata()
    let next = ChatModelSelection(thread: thread)
    // A thread read started before a local write can finish after its readback.
    // Retain the acknowledged choice until this conflicting projection is resolved.
    if hasLoaded, let stored, stored != ChatModelSelection(thread: previous), stored != next {
      needsThreadReadback = true
      return
    }
    needsThreadReadback = false
    stored = next
    hasLoaded = true
  }

  func open() async {
    guard !closed, !Task.isCancelled else { return }
    if models.configuration == nil {
      await models.load()
    }
    guard !closed, !Task.isCancelled else { return }
    if models.configuration != nil {
      if let metadataTask {
        _ = await metadataTask.result
      } else {
        await refresh()
      }
    }
    // Usage never delays the model list; the separate task is cancelled with the sheet.
  }
  func refresh() async {
    guard !closed, !Task.isCancelled, threadID != nil else { return }
    if isSaving {
      refreshAfterSave = true
      return
    }
    cancelMetadata()
    do {
      try models.stateStore.set(reloadMetadata)
      let task = try models.stateStore.get(metadataValue)
      // A cancelled presentation waiter must not cancel the resident conversation's read.
      _ = await task.result
    } catch is CancellationError {
    } catch {
      guard !closed, !Task.isCancelled else { return }
      uncertain = true
      models.report(error)
    }
  }
  /// Starting the first send gives this pending chat its own inherited choice.
  func captureNewChatSelection() -> ChatModelSelection {
    let value = selection
    stored = value
    return value
  }
  func resetNewChat() {
    guard threadID == nil, !isBusy else { return }
    stored = nil
    error = nil
  }
  /// Saves a choice drafted in the model sheet (a model, that model's effort and Fast) as one
  /// write, so the chat never runs on half of it. True once the chat uses the choice; an
  /// unchanged draft has nothing to save.
  @discardableResult
  func apply(_ draft: ChatModelSelection) async -> Bool {
    guard let configuration = models.configuration else { return false }
    let next = configuration.resolved(draft)
    guard next != selection else { return true }
    return await save(next, effort: configuration.requestedEffort(for: next))
  }
  private func save(_ next: ChatModelSelection, effort: String?) async -> Bool {
    guard !closed, !isBusy, !uncertain, models.configuration != nil,
      models.configuration?.row(for: next)?.isConfigurable == true
    else { return false }
    retireMetadata()
    isSaving = true
    defer { isSaving = false }
    guard let threadID else {
      stored = next
      error = nil
      return true
    }
    var accepted = false
    var checkingUncertainWrite = false
    do {
      try await models.service.save(next, effort: effort, threadID: threadID)
      accepted = true
      let confirmed = try await models.service.selection(threadID: threadID)
      guard !closed, !Task.isCancelled else { return false }
      stored = confirmed
      hasLoaded = true
      needsThreadReadback = false
      error = nil
    } catch {
      guard !closed else { return false }
      // A failed response may follow a successful write. Block sends until a fresh read resolves it.
      uncertain = true
      self.error = ChatRequestFailure.message(for: error)
      models.report(error)
      if accepted || ChatRequestFailure.isTransient(error) {
        checkingUncertainWrite = true
        refreshAfterSave = true
      }
    }
    await finishSaving()
    if checkingUncertainWrite && !uncertain && stored != next {
      error = String(localized: "Your model change was not saved. Choose it again to retry.")
    }
    return error == nil && !uncertain
  }
  private func finishSaving() async {
    isSaving = false
    if refreshAfterSave {
      refreshAfterSave = false
      await refresh()
    }
  }
  /// True once this new chat's choice is the default for new chats.
  @discardableResult
  func saveForFutureChats() async -> Bool {
    guard canSaveForFutureChats, !isBusy, !uncertain else { return false }
    isSaving = true
    let value = selection
    defer { isSaving = false }
    do {
      let preference = try await models.service.saveDefault(
        value, effort: value.model.flatMap { value.modelSettings[$0]?.effort })
      guard !closed, !Task.isCancelled else { return false }
      models.applyPreference(preference)
      // Preserve canonical readback after a write while reusing other metadata.
      await models.refresh([.modelPreference])
      guard !closed, !Task.isCancelled else { return false }
      error = nil
    } catch {
      guard !closed else { return false }
      self.error = ChatRequestFailure.message(for: error)
      models.report(error)
    }
    await finishSaving()
    return error == nil
  }
  func close() {
    connectors.close()
    closed = true
    cancelMetadata()
    do { try models.stateStore.set(lifetime, false) } catch { models.report(error) }
    stored = nil
  }

  private func cancelMetadata() {
    metadataTask?.cancel()
    metadataTask = nil
    metadataID = nil
  }

  private func retireMetadata() {
    cancelMetadata()
    do { try models.stateStore.set(clearMetadata) } catch { models.report(error) }
  }

  isolated deinit { metadataTask?.cancel() }
}

/// The model sheet's edits to a drafted choice; nothing is saved until
/// `ChatModelSelectionStore.apply(_:)`.
extension ChatModelSelection {
  /// Fast belongs to a model, so a different model starts at the standard speed. The new
  /// model keeps the effort last chosen for it (`modelSettings`).
  func choosing(model: String?) -> ChatModelSelection {
    var next = self
    if next.model != model {
      next.model = model
      next.serviceTier = nil
    }
    return next
  }
  /// Remembers `effort` for the chosen model, if that model offers it.
  func choosing(effort: String, in configuration: ChatModelConfiguration) -> ChatModelSelection {
    guard let model, configuration.efforts(for: self).contains(effort) else { return self }
    var next = self
    next.modelSettings[model] = ThreadModelSetting(effort: effort)
    return next
  }
  /// Fast ("priority") or the standard speed, if the chosen model offers Fast.
  func choosing(fast: Bool, in configuration: ChatModelConfiguration) -> ChatModelSelection {
    guard configuration.canUseFast(self) else { return self }
    var next = self
    next.serviceTier = fast ? "priority" : nil
    return next
  }
}
