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
  private(set) var error: String?
  private(set) var isLoading = false
  private(set) var active = false
  private var revision = 0
  private var closed = false
  private var reportingCatalog: ModelCatalog?
  private var catalogTask: Task<Void, Never>?
  private let didFail: @MainActor (Error) -> Void

  init(client: APIClient, webURL: URL, didFail: @escaping @MainActor (Error) -> Void) {
    self.webURL = webURL
    service = ChatModelService(client: client)
    connectorAccess = ChatComposerAccess(client: client)
    connectorAuthorization = ChatConnectorService(client: client)
    subscriptions = PersonalSubscriptionStore(client: client, didFail: didFail)
    self.didFail = didFail
    subscriptions.didMutate = { [weak self] in await self?.refresh() }
  }
  func refresh() async {
    guard !closed, !Task.isCancelled else { return }
    active = true
    revision += 1
    let request = revision
    isLoading = true
    defer { if request == revision { isLoading = false } }
    do {
      let result = try await service.load()
      guard !closed, !Task.isCancelled, request == revision else { return }
      configuration = result
      error = nil
    } catch is CancellationError {
    } catch {
      guard !closed, request == revision else { return }
      self.error = error.localizedDescription
      didFail(error)
    }
  }

  var usageCatalog: ModelCatalog? { configuration?.catalog ?? reportingCatalog }

  /// Reporting needs model names even when the model picker has never opened.
  /// This read does not activate model selection or load subscription quotas.
  func loadUsageCatalog() async {
    guard !closed, !Task.isCancelled, usageCatalog == nil else { return }
    if let catalogTask {
      await catalogTask.value
      return
    }
    let task = Task { [weak self] in
      guard let self else { return }
      defer { catalogTask = nil }
      do {
        let result = try await service.catalog()
        guard !closed, !Task.isCancelled else { return }
        reportingCatalog = result
      } catch is CancellationError {
      } catch {
        guard !closed, !Task.isCancelled else { return }
        didFail(error)
      }
    }
    catalogTask = task
    await task.value
  }
  func report(_ failure: Error) {
    guard !closed else { return }
    didFail(failure)
  }
  func applyPreference(_ preference: ModelPreference) {
    guard !closed, let configuration else { return }
    revision += 1
    isLoading = false
    self.configuration = configuration.withPreference(preference)
  }
  func close() {
    closed = true
    revision += 1
    configuration = nil
    catalogTask?.cancel()
    catalogTask = nil
    reportingCatalog = nil
    subscriptions.close()
  }
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
  private(set) var savedDefault = false
  private(set) var uncertain = false
  var isSending = false
  private var refreshAfterSave = false
  private var revision = 0
  private var closed = false

  init(models: ChatModelStore, thread: ChatThread? = nil) {
    self.models = models
    connectors = ComposerConnectorStore(
      service: models.connectorAccess, authorizationService: models.connectorAuthorization,
      webURL: models.webURL, thread: thread, didFail: models.report)
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

  func apply(thread: ChatThread) {
    guard !closed, thread.id == threadID else { return }
    if isSaving {
      refreshAfterSave = true
      return
    }
    // An ambiguous local write still needs its explicit metadata readback.
    guard !uncertain else { return }
    revision += 1
    isLoading = false
    stored = ChatModelSelection(thread: thread)
    hasLoaded = true
  }

  func open() async {
    if models.configuration == nil { await models.refresh() }
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
      let value = try await models.service.selection(threadID: threadID)
      guard !closed, !Task.isCancelled, revision == request else { return }
      stored = value
      hasLoaded = true
      uncertain = false
      error = nil
    } catch is CancellationError {
    } catch {
      guard !closed, revision == request else { return }
      self.error = error.localizedDescription
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
    savedDefault = false
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
    savedDefault = false
    defer { isSaving = false }
    guard let threadID else {
      stored = next
      error = nil
      return
    }
    do {
      try await models.service.save(next, effort: effort, threadID: threadID)
      let confirmed = try await models.service.selection(threadID: threadID)
      guard !closed, !Task.isCancelled else { return }
      stored = confirmed
      hasLoaded = true
      error = nil
    } catch {
      guard !closed else { return }
      // A failed response may follow a successful write. Block sends until a fresh read resolves it.
      uncertain = true
      self.error = error.localizedDescription
      models.report(error)
    }
    await finishSaving()
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
    guard !closed, !isBusy, !uncertain, models.configuration != nil else { return }
    isSaving = true
    let value = selection
    defer { isSaving = false }
    do {
      let preference = try await models.service.saveDefault(
        value, effort: value.model.flatMap { value.modelSettings[$0]?.effort })
      guard !closed, !Task.isCancelled else { return }
      models.applyPreference(preference)
      await models.refresh()
      guard !closed, !Task.isCancelled else { return }
      savedDefault = true
      error = nil
    } catch {
      guard !closed else { return }
      self.error = error.localizedDescription
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
