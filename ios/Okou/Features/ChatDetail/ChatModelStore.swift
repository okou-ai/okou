import ChatData
import ChatDomain
import Foundation
import Observation

/// Shared model metadata has one owner per authenticated workspace. Quota reads are separate.
@MainActor @Observable
final class ChatModelStore {
  let webURL: URL
  let service: ChatModelService
  let subscriptions: PersonalSubscriptionStore
  private(set) var configuration: ChatModelConfiguration?
  private(set) var error: String?
  private(set) var isLoading = false
  private(set) var active = false
  private var revision = 0
  private var closed = false
  private let didFail: @MainActor (Error) -> Void

  init(client: APIClient, webURL: URL, didFail: @escaping @MainActor (Error) -> Void) {
    self.webURL = webURL
    service = ChatModelService(client: client)
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
    subscriptions.close()
  }
}

/// Changes commit before becoming sendable. Opening a sheet only reads metadata.
@MainActor @Observable
final class ChatModelSelectionStore {
  let models: ChatModelStore
  let threadID: String?
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
  var isBusy: Bool { isSaving || isLoading || isSending }
  var canSend: Bool {
    guard models.active else { return true }
    guard models.configuration != nil else { return false }
    return !isSaving && !isLoading && hasLoaded && !uncertain
      && models.configuration?.row(for: selection)?.memberEffective.availability == "available"
  }
  var effectiveEffort: String? { models.configuration?.effectiveEffort(for: selection) }
  var requestedEffort: String? { models.configuration?.requestedEffort(for: selection) }

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
    closed = true
    revision += 1
    stored = nil
  }
}
