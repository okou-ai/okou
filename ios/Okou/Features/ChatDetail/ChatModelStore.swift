import CCState
import ChatData
import ChatDomain
import Foundation

/// Shared model metadata has one owner per authenticated workspace. Quota reads are separate.
/// The confirmed configuration and activation are kept in the workspace session's Store.
@MainActor
final class ChatModelStore {
  /// The confirmed configuration with the last confirmed feature switches applied. The
  /// payloads are not Equatable, so equality follows the revisions of both inputs.
  struct Snapshot: Equatable {
    let configuration: ChatModelConfiguration?
    let switches: SidebarFeatureSwitches?
    /// Distinguishes workspaces whose inputs reach the same revisions.
    fileprivate let origin: UUID
    fileprivate let revisions: [Int]

    var usesFollowupPlaceholder: Bool {
      switches?.effectiveSwitches["followupPlaceholder"] == true
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
      lhs.origin == rhs.origin && lhs.revisions == rhs.revisions
    }
  }
  private struct Confirmed: Equatable {
    var configuration: ChatModelConfiguration?
    var revision = 0

    static func == (lhs: Self, rhs: Self) -> Bool { lhs.revision == rhs.revision }
  }

  let webURL: URL
  let service: ChatModelService
  let connectorAccess: ChatComposerAccess
  let connectorAuthorization: ChatConnectorService
  let subscriptions: PersonalSubscriptionStore
  /// Views resolve it; `configuration` and the accessors below serve actions and tests.
  let snapshotValue: Computed<Snapshot>
  /// Whether a composer or sheet has activated model selection for this workspace.
  let activeValue: Computed<Bool>
  private let confirmed = CCState.State(Confirmed())
  private let activeState = CCState.State(false)
  private var closed = false
  private var publication: Task<ChatModelConfiguration, Error>?
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
    let confirmed = confirmed
    let switches = self.resources.featureSnapshot.confirmedValue
    let origin = UUID()
    snapshotValue = Computed { get in
      let configured = try get(confirmed)
      let current = try get(switches)
      var configuration = configured.configuration
      if let effective = current.switches?.effectiveSwitches {
        configuration = configuration?.withSwitches(effective)
      }
      return Snapshot(
        configuration: configuration, switches: current.switches, origin: origin,
        revisions: [configured.revision, current.revision])
    }
    let activeState = activeState
    activeValue = Computed { try $0(activeState) }
    // Connecting a subscription can also change the server's default model.
    subscriptions.didMutate = { [weak self] in
      await self?.refresh([.runModels, .modelPreference])
    }
  }

  var stateStore: CCState.Store { resources.store }

  /// The current value of `snapshotValue`.
  var snapshot: Snapshot { read(snapshotValue) }
  var configuration: ChatModelConfiguration? { snapshot.configuration }
  var lastKnownFeatureSwitches: SidebarFeatureSwitches? { snapshot.switches }
  var usesFollowupPlaceholder: Bool { snapshot.usesFollowupPlaceholder }
  var active: Bool { read(activeValue) }

  private func read<Value>(_ signal: Signal<Value>) -> Value {
    // Synchronous local business values, not a network or persistence boundary.
    do { return try stateStore.get(signal) } catch {
      preconditionFailure("Cannot read model state: \(error)")
    }
  }

  private func confirm(_ configuration: ChatModelConfiguration?) {
    do {
      let revision = try stateStore.get(confirmed).revision + 1
      try stateStore.set(confirmed, Confirmed(configuration: configuration, revision: revision))
    } catch {
      preconditionFailure("Cannot publish the model configuration: \(error)")
    }
  }

  /// Settings can offer account management before a chat or the model catalog has loaded.
  lazy var subscriptionLinkingEnabled: Computed<Task<Bool, Error>> =
    computedTask { [weak self] get, options in
      guard let self, try get(lifetime), !closed else { throw CancellationError() }
      let features = try get(resources.featureSwitches)
      do {
        let switches = try await features.value
        try Task.checkCancellation()
        try options.signal.checkCancellation()
        return switches.canLinkSubscriptions
      } catch {
        if !Task.isCancelled, !options.signal.isCancelled { report(error) }
        throw error
      }
    }

  /// The graph owns the request and publishes one confirmed snapshot for send admission.
  /// Views observe this Task directly; they do not mirror its loading or error state here.
  lazy var configurationValue =
    Computed<Task<ChatModelConfiguration, Error>> { [weak self] get, options in
      guard let self, try get(lifetime), !closed else { throw CancellationError() }
      let pending = try get(resources.configuration)
      let signal = options.signal
      // Not immediate: the confirmation writes the graph, which must not happen within this
      // evaluation when the shared read has already finished.
      let task = Task { @MainActor [weak self] in
        do {
          let value = try await pending.value
          try signal.checkCancellation()
          try Task.checkCancellation()
          guard let self, !closed else { throw CancellationError() }
          confirm(value)
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
    do {
      try stateStore.set(activeState, true)
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

  /// Reporting resolves model names from the shared catalog read, even when the model picker has
  /// never opened. Reading it does not activate model selection or load subscription quotas.
  var catalog: Computed<Task<ModelCatalog, Error>> { resources.catalogValue }

  /// Retries a failed catalog read for a reporting view and reports a new failure once.
  func loadCatalog() async {
    guard !closed, !Task.isCancelled else { return }
    do {
      _ = try await resources.loadCatalog().value
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
    confirm(configuration.withPreference(preference))
  }
  func close() {
    closed = true
    publication?.cancel()
    publication = nil
    confirm(nil)
    do { try stateStore.set(lifetime, false) } catch { didFail(error) }
    if ownsResources { resources.close() }
    subscriptions.close()
  }

  isolated deinit { publication?.cancel() }
}

/// Changes commit before becoming sendable. Opening a sheet only reads metadata. The confirmed
/// choice and its mutation phases are kept in the workspace session's Store.
@MainActor
final class ChatModelSelectionStore {
  /// What the model control, sheet and failure cards render.
  struct Presentation: Equatable {
    let selection: ChatModelSelection
    let snapshot: ChatModelStore.Snapshot
    let isNewChat: Bool
    let isClosed: Bool
    let isSaving: Bool
    let isRefreshing: Bool
    let isMutating: Bool
    let uncertain: Bool
    /// Mutation outcomes only; metadata read failures remain on the original graph Task.
    let error: String?
    /// The model part of send admission; sending also needs confirmed connector settings.
    let allowsSending: Bool

    var configuration: ChatModelConfiguration? { snapshot.configuration }
    var isBusy: Bool { isMutating || isRefreshing }
    /// The model part of `ChatModelSelectionStore.canSend`; connector settings also gate sending.
    var canSend: Bool { !isRefreshing && allowsSending }
    var effectiveEffort: String? { configuration?.effectiveEffort(for: selection) }
    var requestedEffort: String? { configuration?.requestedEffort(for: selection) }

    /// Whether `choice` (this new chat's choice, or the sheet's draft of it) differs from the
    /// default for new chats, so saving it as that default would change something.
    func canSaveForFutureChats(_ choice: ChatModelSelection) -> Bool {
      guard !isClosed, isNewChat, let configuration else { return false }
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
  }

  private struct Status: Equatable {
    var stored: ChatModelSelection?
    var hasLoaded: Bool
    var isSaving = false
    var isSending = false
    var uncertain = false
    var needsThreadReadback = false
    var error: String?
    var isRefreshing = false
  }

  let models: ChatModelStore
  let threadID: String?
  let connectors: ComposerConnectorStore
  /// Views resolve it; the accessors below serve actions and tests.
  let presentationValue: Computed<Presentation>
  /// `presentationValue` for a view whose composer or conversation may have no model selection.
  private let optionalPresentationValue: Computed<Presentation?>
  private static let noPresentation = Computed<Presentation?> { _ in nil }
  private let status: CCState.State<Status>
  private var refreshAfterSave = false
  private var closed = false
  private let lifecycleTasks: LifecycleTasks
  private let metadataDemand = CCState.State<UUID?>(nil)
  private let lifetime = CCState.State(true)
  private let reloadMetadata: Command<Void, Void>
  private let clearMetadata: Command<Void, Void>
  // The original request also excludes writes until metadata confirmation finishes.
  private var metadataTask: Task<ChatModelSelection?, Error>?
  private var metadataID: UUID?

  convenience init(
    models: ChatModelStore, thread: ChatThread? = nil, lifecycleTasks: LifecycleTasks? = nil
  ) {
    self.init(
      models: models, threadID: thread?.id, cachedSelection: thread.map(ChatModelSelection.init),
      lifecycleTasks: lifecycleTasks)
  }

  init(
    models: ChatModelStore, threadID: String?, cachedSelection: ChatModelSelection? = nil,
    lifecycleTasks: LifecycleTasks? = nil
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
    let snapshot = models.snapshotValue
    connectors = ComposerConnectorStore(
      service: models.connectorAccess, authorizationService: models.connectorAuthorization,
      webURL: models.webURL, graph: models.stateStore, threadID: threadID,
      memberAccessEnabled: { [weak models] in
        models?.lastKnownFeatureSwitches?.usesMemberConnectorAccess == true
      }, readRetrySleep: models.readRetrySleep,
      didFail: models.report)
    self.threadID = threadID
    let status = CCState.State(Status(stored: cachedSelection, hasLoaded: threadID == nil))
    self.status = status
    let active = models.activeValue
    let isNewChat = threadID == nil
    let presentation = Computed<Presentation> { get in
      try Self.present(
        get(status), snapshot: get(snapshot), active: get(active), isNewChat: isNewChat,
        isClosed: !get(lifetime))
    }
    presentationValue = presentation
    optionalPresentationValue = Computed { get in try get(presentation) }
  }

  /// What a view resolves for an optional model selection; nil when there is none.
  static func presentation(of selection: ChatModelSelectionStore?) -> Computed<Presentation?> {
    selection?.optionalPresentationValue ?? noPresentation
  }

  private static func present(
    _ status: Status, snapshot: ChatModelStore.Snapshot, active: Bool, isNewChat: Bool,
    isClosed: Bool
  ) -> Presentation {
    let configuration = snapshot.configuration
    let base = status.stored ?? configuration?.defaultSelection ?? ChatModelSelection()
    let selection = configuration?.resolved(base) ?? base
    let allowsSending: Bool
    if !active {
      allowsSending = true
    } else if let configuration {
      allowsSending =
        !status.isSaving && status.hasLoaded && !status.uncertain
        && configuration.row(for: selection)?.memberEffective.availability == "available"
    } else {
      allowsSending = false
    }
    return Presentation(
      selection: selection, snapshot: snapshot, isNewChat: isNewChat, isClosed: isClosed,
      isSaving: status.isSaving, isRefreshing: status.isRefreshing,
      isMutating: status.isSaving || status.isSending, uncertain: status.uncertain,
      error: status.error, allowsSending: allowsSending)
  }

  /// The current value of `presentationValue`.
  var presentation: Presentation { read(presentationValue) }
  private var current: Status {
    get { read(status) }
    set {
      guard newValue != read(status) else { return }
      do { try models.stateStore.set(status, newValue) } catch {
        preconditionFailure("Cannot publish the model selection: \(error)")
      }
    }
  }
  private var stored: ChatModelSelection? {
    get { current.stored }
    set { current.stored = newValue }
  }
  private(set) var isSaving: Bool {
    get { current.isSaving }
    set { current.isSaving = newValue }
  }
  private(set) var hasLoaded: Bool {
    get { current.hasLoaded }
    set { current.hasLoaded = newValue }
  }
  // Mutation outcomes only; metadata read failures remain on the original graph Task.
  private(set) var error: String? {
    get { current.error }
    set { current.error = newValue }
  }
  private(set) var uncertain: Bool {
    get { current.uncertain }
    set { current.uncertain = newValue }
  }
  private(set) var needsThreadReadback: Bool {
    get { current.needsThreadReadback }
    set { current.needsThreadReadback = newValue }
  }
  var isSending: Bool {
    get { current.isSending }
    set { current.isSending = newValue }
  }

  private func read<Value>(_ signal: Signal<Value>) -> Value {
    // Synchronous local business values, not a network or persistence boundary.
    do { return try models.stateStore.get(signal) } catch {
      preconditionFailure("Cannot read the model selection: \(error)")
    }
  }

  /// Publishes one transition of several status fields as a single graph write.
  private func update(_ change: (inout Status) -> Void) {
    var next = current
    change(&next)
    current = next
  }

  /// Mirrors the owned metadata Task for views. Never called while the read is evaluated.
  private func publishRefreshing() {
    current.isRefreshing = metadataTask != nil
  }

  /// The sheet, composer and background callers observe one conversation-scoped read.
  /// No demand means no metadata I/O, including for an unsent new chat.
  lazy var metadataValue = makeMetadataValue()

  private func makeMetadataValue() -> Computed<Task<ChatModelSelection?, Error>> {
    Computed { [weak self] get, options in
      guard let self, !closed, try get(lifetime) else { throw CancellationError() }
      let demand = try get(metadataDemand)
      let signal = options.signal
      let service = models.service
      let sleep = models.readRetrySleep
      let task: Task<ChatModelSelection?, Error> =
        Task { @MainActor [weak self, service, sleep, threadID] in
          try Task.checkCancellation()
          try signal.checkCancellation()
          guard let self, !closed else { throw CancellationError() }
          guard let demand, let threadID else { return nil }
          defer {
            if metadataID == demand {
              metadataTask = nil
              metadataID = nil
              publishRefreshing()
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
            update {
              $0.stored = value
              $0.hasLoaded = true
              $0.uncertain = false
              $0.needsThreadReadback = false
              $0.error = nil
            }
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

  /// The owned metadata Task decides admission synchronously; views render the mirrored flag.
  var isRefreshing: Bool { metadataTask != nil }
  var selection: ChatModelSelection { presentation.selection }
  var isMutating: Bool { presentation.isMutating }
  var isBusy: Bool { isMutating || isRefreshing }
  var canSend: Bool { !isRefreshing && canSendConfirmedSelection }
  /// Background reads do not invalidate the selection already confirmed for recovery.
  var canSendConfirmedSelection: Bool { connectors.canSend && presentation.allowsSending }
  var effectiveEffort: String? { presentation.effectiveEffort }
  var requestedEffort: String? { presentation.requestedEffort }
  var canSaveForFutureChats: Bool { canSaveForFutureChats(selection) }
  func canSaveForFutureChats(_ choice: ChatModelSelection) -> Bool {
    !closed && presentation.canSaveForFutureChats(choice)
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
    update {
      $0.needsThreadReadback = false
      $0.stored = next
      $0.hasLoaded = true
    }
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
      // Only this method demands a read, so the mirror follows every evaluation that owns one.
      publishRefreshing()
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
    update {
      $0.stored = nil
      $0.error = nil
    }
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
      update {
        $0.stored = next
        $0.error = nil
      }
      return true
    }
    var accepted = false
    var checkingUncertainWrite = false
    do {
      try await models.service.save(next, effort: effort, threadID: threadID)
      accepted = true
      let confirmed = try await models.service.selection(threadID: threadID)
      guard !closed, !Task.isCancelled else { return false }
      update {
        $0.stored = confirmed
        $0.hasLoaded = true
        $0.needsThreadReadback = false
        $0.error = nil
      }
    } catch {
      guard !closed else { return false }
      // A failed response may follow a successful write. Block sends until a fresh read resolves it.
      update {
        $0.uncertain = true
        $0.error = ChatRequestFailure.message(for: error)
      }
      models.report(error)
      if accepted || ChatRequestFailure.isTransient(error) {
        checkingUncertainWrite = true
        refreshAfterSave = true
      }
    }
    await finishSaving()
    guard !closed else { return false }
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
    publishRefreshing()
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
