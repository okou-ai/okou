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
    self.resources = resources ?? WorkspaceResources(client: client, sleep: readRetrySleep)
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
  private(set) var isLoading = false
  private(set) var hasLoaded: Bool
  private(set) var error: String?
  private(set) var uncertain = false
  private(set) var needsThreadReadback = false
  var isSending = false
  private var refreshAfterSave = false
  private var revision = 0
  private var closed = false

  init(models: ChatModelStore, thread: ChatThread? = nil) {
    self.models = models
    connectors = ComposerConnectorStore(
      service: models.connectorAccess, authorizationService: models.connectorAuthorization,
      webURL: models.webURL, thread: thread, readRetrySleep: models.readRetrySleep,
      didFail: models.report)
    threadID = thread?.id
    stored = thread.map(ChatModelSelection.init)
    hasLoaded = thread == nil
  }
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
  var isBusy: Bool { isMutating || isLoading }
  var canSend: Bool { !isLoading && canSendConfirmedSelection }
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
  var canSaveForFutureChats: Bool {
    guard !closed, threadID == nil, let configuration = models.configuration else { return false }
    let current = selection
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
    revision += 1
    isLoading = false
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
    if models.configuration == nil {
      await models.load()
    }
    if models.configuration != nil { await refresh() }
    // Usage never delays the model list; the separate task is cancelled with the sheet.
  }
  func refresh() async {
    guard !closed, !Task.isCancelled, let threadID else { return }
    if isSaving {
      refreshAfterSave = true
      return
    }
    revision += 1
    let request = revision
    isLoading = true
    defer { if request == revision { isLoading = false } }
    do {
      let value = try await ChatReadRecovery.read(
        "saved model selection", sleep: models.readRetrySleep
      ) {
        try await models.service.selection(threadID: threadID)
      }
      guard !closed, !Task.isCancelled, revision == request else { return }
      stored = value
      hasLoaded = true
      uncertain = false
      needsThreadReadback = false
      error = nil
    } catch is CancellationError {
    } catch {
      guard !closed, revision == request else { return }
      self.error = ChatRequestFailure.message(for: error)
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
  func choose(model: String?) async {
    var next = selection
    if next.model != model {
      next.model = model
      next.serviceTier = nil
    }
    await save(next, effort: nil)
  }
  func choose(effort: String) async {
    var next = selection
    guard let model = next.model,
      models.configuration?.efforts(for: next).contains(effort) == true
    else { return }
    next.modelSettings[model] = ThreadModelSetting(effort: effort)
    await save(next, effort: effort)
  }
  func setFast(_ fast: Bool) async {
    guard models.configuration?.canUseFast(selection) == true else { return }
    var next = selection
    next.serviceTier = fast ? "priority" : nil
    await save(next, effort: nil)
  }
  private func save(_ next: ChatModelSelection, effort: String?) async {
    guard !closed, !isBusy, !uncertain, models.configuration != nil,
      models.configuration?.row(for: next)?.isConfigurable == true
    else { return }
    revision += 1
    isSaving = true
    defer { isSaving = false }
    guard let threadID else {
      stored = next
      error = nil
      return
    }
    var accepted = false
    var checkingUncertainWrite = false
    do {
      try await models.service.save(next, effort: effort, threadID: threadID)
      accepted = true
      let confirmed = try await models.service.selection(threadID: threadID)
      guard !closed, !Task.isCancelled else { return }
      stored = confirmed
      hasLoaded = true
      needsThreadReadback = false
      error = nil
    } catch {
      guard !closed else { return }
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
  }
  private func finishSaving() async {
    isSaving = false
    if refreshAfterSave {
      refreshAfterSave = false
      isLoading = true
      await refresh()
    }
  }
  func saveForFutureChats() async {
    guard canSaveForFutureChats, !isBusy, !uncertain else { return }
    isSaving = true
    let value = selection
    defer { isSaving = false }
    do {
      let preference = try await models.service.saveDefault(
        value, effort: value.model.flatMap { value.modelSettings[$0]?.effort })
      guard !closed, !Task.isCancelled else { return }
      models.applyPreference(preference)
      // Preserve canonical readback after a write while reusing other metadata.
      await models.refresh([.modelPreference])
      guard !closed, !Task.isCancelled else { return }
      error = nil
    } catch {
      guard !closed else { return }
      self.error = ChatRequestFailure.message(for: error)
      models.report(error)
    }
    await finishSaving()
  }
  func close() {
    connectors.close()
    closed = true
    revision += 1
    stored = nil
  }
}
