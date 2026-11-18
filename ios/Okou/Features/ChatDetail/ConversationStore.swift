import ChatData
import ChatDomain
import Foundation
import Observation

/// Presentation and local delivery state for one conversation in one workspace.
@MainActor @Observable
final class ConversationStore {
  var failureRecoveryActions: ConversationFailureRecovery { failureRecovery }
  @ObservationIgnored private lazy var failureRecovery = ConversationFailureRecovery(
    conversation: self, commands: commands, lifecycleTasks: lifecycleTasks,
    detailOwner: { [weak self] in self?.detailOwner },
    refresh: { [weak self] in
      guard let self else { return }
      await refresh()
      await reading.waitForRefresh()
    },
    continueMessage: { [weak self] message in
      guard let self else { return }
      pending.append(message)
      reconcileProjection()
      await submit(message)
    }, didRequestNewChat: didRequestNewChat, didSettle: didSettle,
    didFail: { [weak self] in self?.report($0) })
  @ObservationIgnored private lazy var liveOutput = ConversationLiveOutput(
    threadID: thread.id, lifecycleTasks: lifecycleTasks,
    isPersisted: { [weak self] in self?.isPersisted($0) == true },
    publish: { [weak self] in self?.projection.publishStream($0) })

  @ObservationIgnored private lazy var reading = ConversationPresentation(
    conversation: self, projection: projection, sync: sync, commands: commands,
    reads: readResources, lifecycleTasks: lifecycleTasks, liveOutput: liveOutput,
    isClosed: { [weak self] in self?.closed != false }, isVisible: isVisible,
    didMarkRead: didMarkRead, didSettle: didSettle,
    confirmHistory: { [weak self] in self?.history = $0 },
    replacePending: { [weak self] in self?.pending = $0 },
    reconcileProjection: { [weak self] in self?.reconcileProjection() },
    clearStopIssue: { [weak self] in self?.stopIssue = nil },
    cancelRecoverySend: { [weak self] in self?.sendTask?.cancel() },
    report: { [weak self] in self?.report($0) })

  private let lifecycleTasks: LifecycleTasks

  let modelSelection: ChatModelSelectionStore?
  let workflowSource: ComposerWorkflowSource?
  var thread: ChatThread {
    didSet {
      if ChatModelSelection(thread: oldValue) != ChatModelSelection(thread: thread) {
        modelSelection?.apply(thread: thread, replacing: oldValue)
      }
    }
  }
  var draft: String {
    get { composer.text }
    set { composer.text = newValue }
  }
  let composer: ComposerDraftStore
  var attachmentDraft: AttachmentDraftStore { composer.attachments }
  private let draftStorage: ChatDraftStorage?
  private let draftTarget: ChatDraftTarget
  @ObservationIgnored lazy var connectorActions = ConnectorActionStore(
    service: commands.connectorActions, commands: commands, thread: thread,
    didContinue: { [weak self] in
      guard let self, !closed else { return }
      await modelSelection?.connectors.refresh()
      didSend()
      await refresh()
    }, didFail: didFail)
  @ObservationIgnored lazy var attachmentViewer = MessageAttachmentStore(
    commands: commands, didFail: didFail)
  @ObservationIgnored lazy var artifacts = MessageArtifactStore(
    service: commands.artifacts, threadID: thread.id, webURL: webURL, markdown: messageMarkdown,
    didFail: didFail)
  // Confirmed input for delivery, Stop, read watermarks and the native render window.
  // Independent resource phases remain in their original Tasks, not in this snapshot.
  @ObservationIgnored private let projection = ConversationProjection()
  private(set) var history: ChatHistory? {
    get { projection.history }
    set {
      projection.confirmHistory(newValue)
      reconcileActivitySummary()
    }
  }

  var streamedOutputs: [StreamedOutput] { projection.streamed }
  /// Subscribes to a run's live output; set by the workspace, which owns the realtime client.
  @ObservationIgnored var runOutput: ConversationLiveOutput.Subscribe?
  private(set) var pending: [PendingMessage] {
    get { projection.pending }
    set {
      projection.replacePending(newValue)
      persistPending()
    }
  }
  var messages: [ChatMessage] { projection.messages }
  var visibleItems: [ConversationItem] { reading.visibleItems }

  var visibleMessages: [ChatMessage] { visibleItems.compactMap(\.message) }
  var hasEarlierMessages: Bool { reading.hasEarlierMessages }

  var isLoadingEarlier: Bool { reading.isLoadingEarlier }

  var readingPosition: ConversationReadingPosition? { reading.readingPosition }

  var navigationRequest: NavigationRequest? { reading.navigationRequest }

  var isLoading: Bool { reading.isLoading }

  private(set) var isSending = false
  private(set) var deliveryFailures: [String: DeliveryFailure] = [:]
  private(set) var stopIssue: String?

  private let didRequestNewChat: @MainActor () -> Void
  private(set) var isStopping = false { didSet { reconcileActivitySummary() } }
  private(set) var error: String?
  var readSyncError: String? { reading.readSyncError }

  var historySyncError: String? { reading.historySyncError }

  var syncError: String? { historySyncError ?? readSyncError }
  private(set) var needsUpgrade = false
  let webURL: URL
  let messageMarkdown: MessageMarkdownCache
  let measurements: ConversationMeasurementCache
  let activitySummary: ConversationActivitySummary
  let runUsage: ConversationRunUsageStore
  private var detailOwner: UUID? { reading.detailOwner }

  private let sync: ChatSync
  private let readResources: ConversationReadResources
  private let commands: ChatCommands
  private var quickShare: (id: UUID, task: Task<String, Error>)?
  @ObservationIgnored lazy var sharing = ConversationSharing(
    client: commands.approvalClient, threadID: thread.id, webURL: webURL,
    lifecycleTasks: lifecycleTasks, history: { [weak self] in self?.history ?? .empty },
    didFail: didFail)

  func startSharing() {
    guard !closed else { return }
    quickShare?.task.cancel()
    composer.editor.dismissKeyboard()
    sharing.start()
  }

  func cancelSharing() {
    quickShare?.task.cancel()
    sharing.cancel()
  }

  /// Shares one answer together with the request that led to it, as the web does for a
  /// single message: the answer's event plus the user's prompts directly before its turn.
  func shareAnswer(_ messageID: String, audience: ChatShareAudience) async throws -> String {
    quickShare?.task.cancel()
    let id = UUID()
    let task = Task { @MainActor [sharing] in
      let link = try await sharing.singleAnswerLink(messageID, audience: audience)
      try Task.checkCancellation()
      return link.lastPathComponent
    }
    quickShare = (id, task)
    lifecycleTasks.track(task)
    defer { if quickShare?.id == id { quickShare = nil } }
    return try await task.value
  }

  @ObservationIgnored lazy var approvals = ApprovalCardRegistry(
    thread: thread, commands: commands, sync: sync, didFail: didFail,
    didContinue: { [weak self] in
      guard let self, !closed else { return }
      await refresh()
    })
  @ObservationIgnored lazy var permissionActions = PermissionActionRegistry(
    commands: commands, sync: sync, didFail: didFail,
    didContinue: { [weak self] in
      guard let self, !closed else { return }
      await refresh()
      didSend()
    })
  private let isVisible: @MainActor () -> Bool
  private let didMarkRead: @MainActor (Date?) -> Void
  private let didSend: @MainActor () -> Void
  private let didFail: @MainActor (Error) -> Void
  private let didSettle: @MainActor () -> Void
  private var sendTask: Task<Bool, Never>?
  private var stopTask: Task<Void, Never>?
  private var items: [ConversationItem] { projection.items }
  private var closed = false

  init(
    thread: ChatThread, sync: ChatSync, commands: ChatCommands,
    webURL: URL, messageMarkdown: MessageMarkdownCache,
    isVisible: @escaping @MainActor () -> Bool,
    didMarkRead: @escaping @MainActor (Date?) -> Void,
    didSend: @escaping @MainActor () -> Void,
    didFail: @escaping @MainActor (Error) -> Void,
    didSettle: @escaping @MainActor () -> Void,
    modelSelection: ChatModelSelectionStore? = nil,
    workflowSource: ComposerWorkflowSource? = nil,
    activitySleep: @escaping @Sendable (Duration) async throws -> Void = {
      try await Task.sleep(for: $0)
    },
    draftRepository: ChatDraftRepository? = nil, draftStorage: ChatDraftStorage? = nil,
    didSaveDraft: @escaping @MainActor (ComposerDraft) async -> Void = { _ in },
    measurementScope: ChatCacheScope? = nil,
    didRequestNewChat: @escaping @MainActor () -> Void = {},
    readRetrySleep: @escaping @Sendable (Duration) async throws -> Void = {
      try await Task.sleep(for: $0)
    },
    lifecycleTasks: LifecycleTasks? = nil
  ) {
    let lifecycleTasks = lifecycleTasks ?? LifecycleTasks()
    self.lifecycleTasks = lifecycleTasks
    self.modelSelection = modelSelection
    self.workflowSource = workflowSource
    self.didRequestNewChat = didRequestNewChat
    readResources = ConversationReadResources(
      sync: sync, threadID: thread.id, sleep: readRetrySleep, didFail: didFail,
      lifecycleTasks: lifecycleTasks)
    self.runUsage = ConversationRunUsageStore(sync: sync, threadID: thread.id, didFail: didFail)
    self.activitySummary = ConversationActivitySummary(
      sync: sync, threadID: thread.id, didRequireUpgrade: didFail, sleep: activitySleep,
      lifecycleTasks: lifecycleTasks)
    self.thread = thread
    measurements = ConversationMeasurementCache(
      namespace: measurementScope.map {
        [$0.apiBaseURL.absoluteString, $0.userID, $0.workspaceID, thread.id]
      })
    self.draftStorage = draftStorage
    draftTarget = .thread(thread.id)
    composer = ComposerDraftStore(
      target: draftTarget, commands: commands,
      repository: draftRepository, storage: draftStorage, didFail: didFail,
      didSave: didSaveDraft,
      syncSleep: readRetrySleep, lifecycleTasks: lifecycleTasks)
    self.sync = sync
    self.commands = commands
    self.webURL = webURL
    self.messageMarkdown = messageMarkdown
    self.isVisible = isVisible
    self.didMarkRead = didMarkRead
    self.didSend = didSend
    self.didFail = didFail
    self.didSettle = didSettle
    do {
      var restored =
        try draftStorage?.load(draftTarget.key + "/pending", as: [PendingMessage].self) ?? []
      for index in restored.indices { restored[index].needsRetry = true }
      projection.replacePending(restored)
      // Recovery inputs do not consume the composer; two absent documents are not an identity.
      if pending.contains(where: {
        $0.document != nil
          && $0.document?.trimmingWhitespace()
            == composer.value.draftUserMessage?.trimmingWhitespace()
      }) {
        composer.clear()
      }
      reconcileProjection()
    } catch { show(error) }
  }

  var canRelease: Bool {
    (!composer.hasContent || composer.isDurable) && composer.voice?.isWorking != true
      && pending.isEmpty
      && modelSelection?.isBusy != true
      && !isLoading && !isSending && !isStopping && !isLoadingEarlier
      && !isRecoveringFailure && !permissionActions.isBusy
      && history?.executionState.isActive != true
  }

  func restoreCached() async {
    await reading.restoreCached()
  }

  func refresh(waitForCurrent: Bool = false) async {
    await reading.refresh(waitForCurrent: waitForCurrent)
  }

  /// Revisit an indicator watermark without fetching history again. A resident
  /// refresh still owns its history/recovery confirmation before this decision.
  func reconcileReadState() async {
    await reading.reconcileReadState()
  }

  private func markVisibleDeliveryRead() async {
    await reading.markVisibleDeliveryRead()
  }

  func setAutomaticReadSuppressed(_ suppressed: Bool, resetReadWatermark: Bool = false) {
    reading.setAutomaticReadSuppressed(suppressed, resetReadWatermark: resetReadWatermark)
  }

  func quote(_ selection: ChatFeedbackSelection) {
    guard !closed, !needsUpgrade,
      let message = messages.first(where: { $0.id == selection.eventID }),
      message.text.utf16.elementsEqual(selection.text.utf16),
      message.role == .assistant, !message.isError
    else { return }
    composer.addFeedback(selection)
  }

  /// A first send carries the selection acknowledged by thread creation. It must not
  /// wait for the new detail view's independent metadata read to become sendable.
  func send(
    initialMessage: PendingMessage? = nil,
    initialSelection: ChatModelSelection? = nil, initialComputerAccess: ChatComputerAccess? = nil,
    willSend: (@MainActor (String) -> Void)? = nil
  ) async {
    guard composer.hasContent, composer.canSend, attachmentDraft.isReady,
      !isSending, !isRecoveringFailure, !closed, !needsUpgrade, !Task.isCancelled
    else { return }
    guard initialSelection != nil || modelSelection?.canSend != false else { return }
    let messageID = initialMessage?.id ?? UUID().uuidString.lowercased()
    willSend?(messageID)
    // Resigning can commit marked text. Capture the message after native editing ends.
    composer.editor.dismissKeyboard()
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    var message =
      initialMessage
      ?? PendingMessage(
        id: messageID, text: text, createdAt: Date(),
        attachments: attachmentDraft.uploaded,
        document: composer.value.draftUserMessage?.trimmingWhitespace())
    if let initialSelection {
      message.modelSelection = initialSelection
      message.reasoningEffort = modelSelection?.models.configuration?.requestedEffort(
        for: initialSelection)
    } else if modelSelection?.models.configuration != nil {
      message.modelSelection = modelSelection?.selection
      message.reasoningEffort = modelSelection?.requestedEffort
    }
    message.computerAccess = initialComputerAccess
    pending.append(message)
    reconcileProjection()
    composer.clear()
    composer.requestSync()
    await submit(message)
  }

  func retry(_ message: PendingMessage) async {
    guard !isRecoveringFailure else { return }
    await refresh()
    // An existing refresh must finish reconciliation before an explicit resubmission.
    await reading.waitForRefresh()
    guard historySyncError == nil, pending.contains(where: { $0.id == message.id }) else { return }
    await submit(message)
  }

  private func submit(_ message: PendingMessage) async {
    guard sendTask == nil, !closed, !needsUpgrade, !Task.isCancelled else { return }
    isSending = true
    modelSelection?.isSending = true
    let task = Task { [weak self] in
      guard let self else { return false }
      defer {
        isSending = false
        modelSelection?.isSending = false
        sendTask = nil
        didSettle()
      }
      var submitted = false
      do {
        let workflowIDs =
          try await workflowSource?.prepareUse(
            in: message.text, document: message.document, agentID: thread.agentID) ?? []
        submitted = true
        _ = try await commands.send(
          thread: thread, text: message.text, attachments: message.attachments,
          document: message.document,
          clientEventID: message.id, modelSelection: message.modelSelection,
          reasoningEffort: message.reasoningEffort, computerAccess: message.computerAccess)
        try Task.checkCancellation()
        guard !closed else { return false }
        workflowSource?.recordUse(workflowIDs)
        if let index = pending.firstIndex(where: { $0.id == message.id }) {
          pending[index].needsRetry = false
        }
        deliveryFailures[message.id] = nil
        error = nil
        return true
      } catch {
        guard !closed else { return false }
        if let index = pending.firstIndex(where: { $0.id == message.id }) {
          pending[index].needsRetry = true
        }
        let status = (error as? APIClientError)?.statusCode
        if !submitted
          || status.map({ (400..<500).contains($0) && ![408, 409].contains($0) }) == true
        {
          deliveryFailures[message.id] = .notSent(
            String(localized: "Message not sent. ") + ChatRequestFailure.message(for: error))
        } else {
          deliveryFailures[message.id] = .unconfirmed
        }
        report(error)
        return false
      }
    }
    lifecycleTasks.track(task)
    sendTask = task
    // API acceptance ends sending. History can publish a failure card before its
    // read/mark-read work settles, and that card must already accept recovery.
    guard await task.value, !closed, !needsUpgrade, !Task.isCancelled else { return }
    await refresh()
    didSend()
  }

  func stop() async {
    guard stopTask == nil, !closed, !needsUpgrade, !Task.isCancelled else { return }
    isStopping = true
    stopIssue = nil
    let task = Task { [weak self] in
      guard let self else { return }
      defer {
        isStopping = false
        stopTask = nil
        didSettle()
      }
      do {
        try await commands.stop(thread: thread)
        try Task.checkCancellation()
        guard !closed else { return }
        await refresh()
      } catch is CancellationError {
      } catch {
        guard !closed, !Task.isCancelled else { return }
        stopIssue = String(localized: "Stopping has not been confirmed.")
        report(error)
        await refresh()
      }
    }
    lifecycleTasks.track(task)
    stopTask = task
    await task.value
  }

  func setDetailVisible(_ visible: Bool, owner: UUID) {
    reading.setDetailVisible(visible, owner: owner)
  }

  func reconcileVisibility() {
    reading.reconcileVisibility()
  }

  func reconcileActivitySummary() {
    reading.reconcileActivitySummary()
  }

  private func isPersisted(_ eventID: String) -> Bool {
    history?.persistedEventIDs.contains(eventID) == true
      || history?.messages.contains(where: { $0.id.lowercased() == eventID }) == true
  }

  func close() {
    quickShare?.task.cancel()
    sharing.close()
    closed = true
    liveOutput.close()
    activitySummary.close()
    runUsage.close()
    modelSelection?.close()
    cancelRefresh()
    readResources.close()
    projection.close()
    sendTask?.cancel()
    stopTask?.cancel()
    reading.close()
    failureRecovery.close()
    measurements.clear()
    composer.close()
    attachmentViewer.close()
    artifacts.close()
    connectorActions.close()
    permissionActions.close()
    approvals.close()
  }

  func cancelRefresh() {
    reading.cancelRefresh()
  }

  func artifactImageSources(for messageID: String) -> [String] {
    return reading.artifactImageSources(for: messageID)
  }

  func rememberReadingPosition(_ position: ConversationReadingPosition?) {
    reading.rememberReadingPosition(position)
  }

  /// A run link lands on its original input, matching the PWA's run anchor.
  @discardableResult
  func revealRun(_ id: String) -> Bool {
    return reading.revealRun(id)
  }

  func earlierWindowMessages() -> [ChatMessage] {
    return reading.earlierWindowMessages()
  }

  func loadEarlierMessages() async {
    await reading.loadEarlierMessages()
  }

  func resetRenderWindowToLatest() {
    reading.resetRenderWindowToLatest()
  }

  func preserveRenderWindow() {
    reading.preserveRenderWindow()
  }

  // Release without changing coordinates during cancellation or a native keyboard animation.
  // The next projection update can advance the boundary, unless history reading has resumed.
  func releaseRenderWindow() {
    reading.releaseRenderWindow()
  }

  func toggleWorkHistory(_ sectionID: String) {
    guard !closed else { return }
    projection.toggleWorkHistory(sectionID)
    reconcileProjection()
  }

  /// Hand a derived projection to the native window after confirmed business changes.
  private func reconcileProjection() {
    let pendingIDs = Set(pending.map(\.id))
    deliveryFailures = deliveryFailures.filter { pendingIDs.contains($0.key) }
    failureRecovery.requestFailureAccounts()
    reading.reconcileWindow()
  }

  private func persistPending() {
    do { try draftStorage?.save(pending, key: draftTarget.key + "/pending") } catch { show(error) }
  }

  private func show(_ failure: Error) {
    guard !closed else { return }
    error = failure.localizedDescription
    report(failure)
  }

  private func report(_ failure: Error) {
    guard !closed else { return }
    needsUpgrade = (failure as? APIClientError)?.statusCode == 426
    didFail(failure)
  }
}
