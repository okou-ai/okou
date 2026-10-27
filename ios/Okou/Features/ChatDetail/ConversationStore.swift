import ChatData
import ChatDomain
import Foundation
import Observation

/// Presentation and local delivery state for one conversation in one workspace.
@MainActor @Observable
final class ConversationStore {
  struct PendingMessage: Codable, Identifiable {
    let id: String
    let text: String
    let createdAt: Date
    let attachments: [ChatAttachment]
    var document: ChatDraftDocument? = nil
    var modelSelection: ChatModelSelection? = nil
    var reasoningEffort: String? = nil
    var computerAccess: ChatComputerAccess? = nil
    var needsRetry = false

    var message: ChatMessage {
      ChatMessage(
        id: id, role: .user,
        text: text,
        attachments: attachments.map {
          ChatMessageAttachment(
            id: $0.id, filename: $0.filename, contentType: $0.contentType, size: $0.size)
        }, createdAt: createdAt,
        runID: nil, isQueued: false, isError: false,
        userMessage: document.flatMap { draft in
          guard let data = try? JSONEncoder().encode(draft) else { return nil }
          return try? JSONDecoder().decode(ChatUserMessage.self, from: data)
        })
    }
  }

  let modelSelection: ChatModelSelectionStore?
  let workflowSource: ComposerWorkflowSource?
  var thread: ChatThread
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
      guard let self else { return }
      didSend()
      await refresh()
    }, didFail: didFail)
  @ObservationIgnored lazy var attachmentViewer = MessageAttachmentStore(
    commands: commands, didFail: didFail)
  @ObservationIgnored lazy var artifacts = MessageArtifactStore(
    service: commands.artifacts, threadID: thread.id, webURL: webURL, markdown: messageMarkdown,
    didFail: didFail)
  private(set) var history: ChatHistory? { didSet { reconcileActivitySummary() } }
  private(set) var pending: [PendingMessage] = [] {
    didSet { persistPending() }
  }
  private(set) var messages: [ChatMessage] = []
  private(set) var visibleItems: [ConversationItem] = []
  var visibleMessages: [ChatMessage] { visibleItems.compactMap(\.message) }
  private(set) var hasEarlierMessages = false
  private(set) var isLoadingEarlier = false
  private(set) var readingPosition: ConversationReadingPosition?
  private(set) var navigationRequest: NavigationRequest?
  struct NavigationRequest: Equatable {
    let id = UUID()
    let position: ConversationReadingPosition
  }
  private(set) var isLoading = false
  private(set) var isSending = false
  private(set) var isRecoveringFailure = false
  private var failureAccountsReadyID: String?
  private var failureAccountBaseline: Int?
  private var failureContextRevision = UUID()
  private var failureAccountsRequestedID: String?
  private var failureAccountsTask: Task<Void, Never>?
  private var failureRecoveryTask: Task<Void, Never>?
  private var failureBilling: ChatBillingRecovery?
  private var failureBillingError: String?
  private let didRequestNewChat: @MainActor () -> Void
  private(set) var isStopping = false { didSet { reconcileActivitySummary() } }
  private(set) var error: String?
  private(set) var needsUpgrade = false
  let webURL: URL
  let messageMarkdown: MessageMarkdownCache
  let measurements = ConversationMeasurementCache()
  let activitySummary: ConversationActivitySummary
  let runUsage: ConversationRunUsageStore
  private var detailOwner: UUID?

  private let sync: ChatSync
  private let commands: ChatCommands
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
  private var refreshAgain = false
  private var refreshTask: Task<Void, Never>?
  private var refreshGeneration = UUID()
  private let readRetrySleep: @Sendable (Duration) async throws -> Void
  private var sendTask: Task<Void, Never>?
  private var stopTask: Task<Void, Never>?
  private var expansionTask: Task<Void, Never>?
  private var renderWindow = ConversationRenderWindow()
  @ObservationIgnored private var preservesRenderWindow = false
  private var items: [ConversationItem] = []
  private var expandedWorkSections: Set<String> = []
  private var closed = false
  private var suppressAutomaticRead = false
  private var manualUnreadThrough: Date?
  private var locallyReadThrough: Date?

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
    didRequestNewChat: @escaping @MainActor () -> Void = {},
    readRetrySleep: @escaping @Sendable (Duration) async throws -> Void = {
      try await Task.sleep(for: $0)
    }
  ) {
    self.modelSelection = modelSelection
    self.workflowSource = workflowSource
    self.didRequestNewChat = didRequestNewChat
    self.readRetrySleep = readRetrySleep
    self.runUsage = ConversationRunUsageStore(sync: sync, threadID: thread.id, didFail: didFail)
    self.activitySummary = ConversationActivitySummary(
      sync: sync, threadID: thread.id, didRequireUpgrade: didFail, sleep: activitySleep)
    self.thread = thread
    self.draftStorage = draftStorage
    draftTarget = .thread(thread.id)
    composer = ComposerDraftStore(
      target: draftTarget, commands: commands,
      repository: draftRepository, storage: draftStorage, didFail: didFail)
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
      pending =
        try draftStorage?.load(draftTarget.key + "/pending", as: [PendingMessage].self) ?? []
      for index in pending.indices { pending[index].needsRetry = true }
      // Recovery inputs do not consume the composer; two absent documents are not an identity.
      if pending.contains(where: {
        $0.document != nil && $0.document == composer.value.draftUserMessage
      }) {
        composer.clear()
      }
      rebuildMessages()
    } catch { show(error) }
  }

  var canRelease: Bool {
    (!composer.hasContent || composer.isDurable) && pending.isEmpty
      && modelSelection?.isBusy != true
      && !isLoading && !isSending && !isStopping && !isLoadingEarlier
      && !isRecoveringFailure && !permissionActions.isBusy
      && history?.executionState.isActive != true
  }

  func restoreCached() async {
    guard !closed, !needsUpgrade, !Task.isCancelled else { return }
    let generation = refreshGeneration
    let previousIDs = history?.persistedEventIDs
    guard let cached = await sync.cachedHistory(threadID: thread.id),
      previousIDs != cached.persistedEventIDs
    else { return }
    await messageMarkdown.prepareLatest(cached.messages)
    guard !closed, !Task.isCancelled, refreshGeneration == generation,
      history?.persistedEventIDs == previousIDs
    else { return }
    history = cached
    pending.removeAll { cached.persistedEventIDs.contains($0.id) }
    rebuildMessages()
  }

  func refresh(waitForCurrent: Bool = false) async {
    guard !closed, !needsUpgrade, !Task.isCancelled else { return }
    if let refreshTask {
      refreshAgain = true
      if waitForCurrent { await refreshTask.value }
      return
    }
    let generation = refreshGeneration
    let task = Task { [weak self] in
      guard let self else { return }
      defer {
        if refreshGeneration == generation {
          isLoading = false
          refreshTask = nil
        }
        didSettle()
      }
      guard !Task.isCancelled, refreshGeneration == generation else { return }
      await restoreCached()
      guard !closed, !Task.isCancelled, refreshGeneration == generation else { return }
      isLoading = true
      repeat {
        refreshAgain = false
        do {
          let result = try await ChatReadRecovery.read("chat history", sleep: readRetrySleep) {
            try await sync.history(threadID: thread.id)
          }
          await messageMarkdown.prepareLatest(result.messages)
          try Task.checkCancellation()
          guard !closed, refreshGeneration == generation else { return }
          if history != result { history = result }
          pending.removeAll { result.persistedEventIDs.contains($0.id) }
          rebuildMessages()
          await permissionActions.refresh()
          guard !closed, !Task.isCancelled, refreshGeneration == generation else { return }
          if !pending.contains(where: \.needsRetry) { error = nil }
          let unreadThrough = [result.latestRunFinishAt, thread.unreadAt].compactMap { $0 }.max()
          if suppressAutomaticRead, let unreadThrough {
            if let manualUnreadThrough {
              // Preserve the explicitly unread delivery; a later delivery can be read normally.
              if unreadThrough > manualUnreadThrough { suppressAutomaticRead = false }
            } else {
              manualUnreadThrough = unreadThrough
            }
          }
          if isVisible(), !suppressAutomaticRead, let unreadThrough,
            locallyReadThrough.map({ $0 < unreadThrough }) ?? true
          {
            let watermark = try await commands.markRead(threadID: thread.id)
            guard !closed, !Task.isCancelled else { return }
            if let watermark {
              locallyReadThrough = max(locallyReadThrough ?? watermark, watermark)
              if suppressAutomaticRead {
                manualUnreadThrough = max(manualUnreadThrough ?? watermark, watermark)
              }
            }
            if !suppressAutomaticRead { didMarkRead(watermark) }
          }
        } catch is CancellationError {
          return
        } catch {
          guard !Task.isCancelled, refreshGeneration == generation else { return }
          show(error)
        }
      } while refreshAgain && !closed && !needsUpgrade && !Task.isCancelled
    }
    refreshTask = task
    await task.value
  }

  func setAutomaticReadSuppressed(_ suppressed: Bool, resetReadWatermark: Bool = false) {
    guard !closed else { return }
    if suppressed {
      manualUnreadThrough = [history?.latestRunFinishAt, thread.unreadAt, locallyReadThrough]
        .compactMap { $0 }.max()
    } else {
      if resetReadWatermark { locallyReadThrough = nil }
      manualUnreadThrough = nil
    }
    suppressAutomaticRead = suppressed
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
    initialSelection: ChatModelSelection? = nil, initialComputerAccess: ChatComputerAccess? = nil,
    willSend: (@MainActor (String) -> Void)? = nil
  ) async {
    guard composer.hasContent, composer.canSend, attachmentDraft.isReady,
      !isSending, !isRecoveringFailure, !closed, !needsUpgrade, !Task.isCancelled
    else { return }
    guard initialSelection != nil || modelSelection?.canSend != false else { return }
    let messageID = UUID().uuidString.lowercased()
    willSend?(messageID)
    // Resigning can commit marked text. Capture the message after native editing ends.
    composer.editor.dismissKeyboard()
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    var message = PendingMessage(
      id: messageID, text: text, createdAt: Date(),
      attachments: attachmentDraft.uploaded, document: composer.value.draftUserMessage)
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
    rebuildMessages()
    composer.clear()
    composer.requestSync()
    await submit(message)
  }

  func retry(_ message: PendingMessage) async {
    guard !isRecoveringFailure else { return }
    await refresh()
    // An existing refresh must finish reconciliation before an explicit resubmission.
    if let refreshTask { await refreshTask.value }
    guard pending.contains(where: { $0.id == message.id }) else { return }
    await submit(message)
  }

  func failureState(_ failure: ChatFailure) -> AssistantFailureState {
    var state = AssistantFailureState.make(
      failure: failure,
      current: !closed && !needsUpgrade && pending.isEmpty
        && history?.latestFailureID == failure.id,
      selection: modelSelection,
      accountsReady: failureAccountsReadyID == failure.id
        || (failureAccountsRequestedID == failure.id
          && failureAccountBaseline.map {
            (modelSelection?.models.subscriptions.accountRevision ?? 0) > $0
          } == true),
      busy: isRecoveringFailure || isSending)
    if state.isCurrent {
      state.billing = failureBilling
      state.billingError = failureBillingError
    }
    return state
  }

  func newChatAfterFailure(_ id: String) {
    guard history?.latestFailureID == id, pending.isEmpty, !closed else { return }
    didRequestNewChat()
  }

  func refreshFailureAccounts() async {
    guard !closed, let id = history?.latestFailureID else { return }
    let request = UUID()
    failureContextRevision = request
    failureAccountsReadyID = nil
    if let failure = messages.first(where: { $0.id == id })?.failure,
      failure.recovery(personalFramework: nil).kind == .billing
    {
      do {
        let result = try await commands.billingRecovery()
        guard !closed, !Task.isCancelled, history?.latestFailureID == id,
          failureContextRevision == request
        else { return }
        failureBilling = result
        failureBillingError = nil
      } catch {
        guard !closed, !Task.isCancelled, history?.latestFailureID == id,
          failureContextRevision == request
        else { return }
        failureBillingError = error.localizedDescription
        show(error)
      }
      return
    }
    guard let modelSelection,
      let failure = messages.first(where: { $0.id == id })?.failure,
      failure.recovery(personalFramework: nil).kind == .usage
    else { return }
    failureAccountBaseline = modelSelection.models.subscriptions.accountRevision
    let succeeded = await modelSelection.models.subscriptions.refresh(force: true)
    guard succeeded, !closed, !Task.isCancelled, history?.latestFailureID == id,
      failureContextRevision == request
    else { return }
    failureAccountsReadyID = id
  }

  /// Execution recovery appends a new input. Uncertain delivery still uses retry(_:).
  func recoverFailure(_ id: String, resetUsage: Bool = false) async {
    guard !closed, !needsUpgrade, !isRecoveringFailure, !isSending, pending.isEmpty,
      history?.latestFailureID == id, let failure = messages.first(where: { $0.id == id })?.failure,
      failureState(failure).recovery.canRetry, modelSelection?.canSend != false,
      modelSelection?.isBusy != true
    else { return }
    isRecoveringFailure = true
    modelSelection?.isSending = true
    let owner = detailOwner
    let task = Task { [weak self] in
      guard let self else { return }
      defer {
        isRecoveringFailure = false
        modelSelection?.isSending = false
        failureRecoveryTask = nil
        didSettle()
      }
      await refresh()
      if let refreshTask { await refreshTask.value }
      await modelSelection?.refresh()
      guard !closed, !needsUpgrade, !Task.isCancelled, detailOwner == owner,
        history?.latestFailureID == id, pending.isEmpty, error == nil,
        failureState(failure).recovery.canRetry, modelSelection?.canSend != false
      else { return }
      if resetUsage {
        await refreshFailureAccounts()
        let state = failureState(failure)
        guard !closed, !needsUpgrade, !Task.isCancelled, detailOwner == owner,
          history?.latestFailureID == id, modelSelection?.canSend != false,
          let accountID = state.resetAccountID,
          let subscriptions = modelSelection?.models.subscriptions,
          let account = subscriptions.accounts.first(where: { $0.id == accountID }),
          await subscriptions.reset(account)
        else { return }
      }
      guard !closed, !needsUpgrade, !Task.isCancelled, detailOwner == owner,
        history?.latestFailureID == id, pending.isEmpty, modelSelection?.canSend != false
      else { return }
      let message = PendingMessage(
        id: UUID().uuidString.lowercased(), text: "continue", createdAt: Date(), attachments: [],
        modelSelection: modelSelection?.selection, reasoningEffort: modelSelection?.requestedEffort)
      pending.append(message)
      rebuildMessages()
      await submit(message)
    }
    failureRecoveryTask = task
    await task.value
  }

  private func submit(_ message: PendingMessage) async {
    guard !isSending, !closed, !needsUpgrade, !Task.isCancelled else { return }
    isSending = true
    modelSelection?.isSending = true
    let task = Task { [weak self] in
      guard let self else { return }
      defer {
        isSending = false
        modelSelection?.isSending = false
        sendTask = nil
        didSettle()
      }
      do {
        let workflowIDs =
          try await workflowSource?.prepareUse(
            in: message.text, document: message.document, agentID: thread.agentID) ?? []
        _ = try await commands.send(
          thread: thread, text: message.text, attachments: message.attachments,
          document: message.document,
          clientEventID: message.id, modelSelection: message.modelSelection,
          reasoningEffort: message.reasoningEffort, computerAccess: message.computerAccess)
        try Task.checkCancellation()
        guard !closed else { return }
        workflowSource?.recordUse(workflowIDs)
        if let index = pending.firstIndex(where: { $0.id == message.id }) {
          pending[index].needsRetry = false
        }
        error = nil
        await refresh()
        didSend()
      } catch {
        guard !closed else { return }
        if let index = pending.firstIndex(where: { $0.id == message.id }) {
          pending[index].needsRetry = true
        }
        show(error)
      }
    }
    sendTask = task
    await task.value
  }

  func stop() async {
    guard !isStopping, !closed, !needsUpgrade, !Task.isCancelled else { return }
    isStopping = true
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
      } catch { show(error) }
    }
    stopTask = task
    await task.value
  }

  func setDetailVisible(_ visible: Bool, owner: UUID) {
    if visible {
      detailOwner = owner
      composer.requestSync()
    } else {
      // A previous view can disappear after its replacement has already appeared.
      guard detailOwner == owner else { return }
      detailOwner = nil
      attachmentViewer.deactivate()
      artifacts.deactivate()
      failureAccountsTask?.cancel()
      failureAccountsTask = nil
      failureAccountsRequestedID = nil
      failureRecoveryTask?.cancel()
      if isRecoveringFailure { sendTask?.cancel() }
      permissionActions.deactivate()
    }
    reconcileVisibility()
  }

  func reconcileVisibility() {
    reconcileActivitySummary()
    if detailOwner != nil && isVisible() { requestFailureAccounts() }
    reconcileRunUsage()
  }

  func reconcileActivitySummary() {
    activitySummary.demand(
      !closed && !needsUpgrade && detailOwner != nil && isVisible()
        && !isStopping
        && history?.executionState == .running ? history?.activityRunID : nil)
  }

  func close() {
    closed = true
    activitySummary.stop()
    runUsage.close()
    modelSelection?.close()
    cancelRefresh()
    sendTask?.cancel()
    stopTask?.cancel()
    expansionTask?.cancel()
    failureAccountsTask?.cancel()
    failureRecoveryTask?.cancel()
    measurements.clear()
    composer.close()
    attachmentViewer.close()
    artifacts.close()
    connectorActions.close()
    permissionActions.close()
  }

  func cancelRefresh() {
    refreshGeneration = UUID()
    refreshTask?.cancel()
    refreshTask = nil
    refreshAgain = false
    isLoading = false
  }

  func artifactImageSources(for messageID: String) -> [String] {
    guard let index = items.firstIndex(where: { $0.id == messageID }) else { return [] }
    var start = index
    while start > 0, !items[start].beginsWorkSection, items[start - 1].role == items[index].role {
      start -= 1
    }
    var end = index + 1
    while end < items.count, !items[end].beginsWorkSection, items[end].role == items[index].role {
      end += 1
    }
    return items[start..<end].compactMap(\.message).map(\.text)
  }

  func rememberReadingPosition(_ position: ConversationReadingPosition?) {
    guard !closed else { return }
    // A disappearing/recycled row may still report an identity that replay just revoked.
    if let position, position.messageID != readingPosition?.messageID,
      !items.contains(where: { $0.id == position.messageID })
    {
      return
    }
    if position == nil { renderWindow.resumeFollowing() } else { renderWindow.pauseFollowing() }
    if readingPosition != position { readingPosition = position }
  }

  /// A run link lands on its original input, matching the PWA's run anchor.
  @discardableResult
  func revealRun(_ id: String) -> Bool {
    guard !closed, let message = messages.first(where: { $0.runID == id && $0.role == .user }),
      items.contains(where: { $0.id == message.id })
    else { return false }
    let position = ConversationReadingPosition(messageID: message.id, offset: 0)
    rememberReadingPosition(position)
    renderWindow.include(message.id)
    publishWindow()
    navigationRequest = NavigationRequest(position: position)
    return true
  }

  func loadEarlierMessages() async {
    guard !closed, !needsUpgrade, !Task.isCancelled, hasEarlierMessages, expansionTask == nil else {
      return
    }
    isLoadingEarlier = true
    let task = Task { [weak self] in
      guard let self else { return }
      defer {
        expansionTask = nil
        isLoadingEarlier = false
        didSettle()
      }
      // Warm only the landing rows immediately above the current boundary, not the entire page.
      await messageMarkdown.prepareLatest(
        Array(items.prefix(renderWindow.range.lowerBound).compactMap(\.message).suffix(4)))
      guard !closed, !needsUpgrade, !Task.isCancelled else { return }
      // Refresh/send may have changed the projection while preparation was suspended.
      renderWindow.expand()
      publishWindow()
    }
    expansionTask = task
    await task.value
  }

  func resetRenderWindowToLatest() {
    guard !closed else { return }
    expansionTask?.cancel()
    readingPosition = nil
    renderWindow.resetToLatest()
    publishWindow()
  }

  func preserveRenderWindow() { preservesRenderWindow = true }

  // Release without changing coordinates during cancellation or a native keyboard animation.
  // The next projection update can advance the boundary, unless history reading has resumed.
  func releaseRenderWindow() { preservesRenderWindow = false }

  func toggleWorkHistory(_ sectionID: String) {
    guard !closed, let section = history?.workSections.first(where: { $0.id == sectionID }),
      section.isCollapsible
    else { return }
    if !expandedWorkSections.insert(sectionID).inserted {
      expandedWorkSections.remove(sectionID)
    }
    rebuildMessages()
  }

  private func rebuildMessages() {
    let persisted = history?.persistedEventIDs ?? []
    let next =
      (history?.messages ?? []) + pending.filter { !persisted.contains($0.id) }.map(\.message)
    if messages != next { messages = next }
    requestFailureAccounts()
    let sections = history?.workSections ?? []
    expandedWorkSections.formIntersection(sections.map(\.id))
    let headers = Dictionary(
      uniqueKeysWithValues: sections.map { ($0.hiddenMessageIDs.first ?? $0.anchorMessageID, $0) })
    let hiddenSections = Dictionary(
      uniqueKeysWithValues: sections.flatMap { section in
        section.hiddenMessageIDs.map { ($0, section) }
      })
    var nextItems: [ConversationItem] = []
    let usageAnchors = history?.runUsageAnchors ?? [:]
    for message in next {
      if let section = headers[message.id] {
        nextItems.append(.work(section, expanded: expandedWorkSections.contains(section.id)))
      }
      if let section = hiddenSections[message.id] {
        if section.isCollapsible && !expandedWorkSections.contains(section.id) { continue }
        nextItems.append(.message(message, isWorkHistory: true))
      } else {
        nextItems.append(.message(message))
      }
      if let runID = message.runID, usageAnchors[runID] == message.id,
        history?.usageEventIDs[runID] != nil
      {
        nextItems.append(.usage(runID: runID))
      }
    }
    guard items != nextItems else {
      reconcileRunUsage()
      return
    }
    if let position = readingPosition, !nextItems.contains(where: { $0.id == position.messageID }) {
      let surviving = Set(nextItems.map(\.id))
      if let index = items.firstIndex(where: { $0.id == position.messageID }),
        let replacement = items.dropFirst(index + 1).first(where: { surviving.contains($0.id) })
          ?? items.prefix(index).last(where: { surviving.contains($0.id) })
      {
        readingPosition = ConversationReadingPosition(
          messageID: replacement.id, offset: position.offset)
      } else {
        readingPosition = nil
      }
    }
    items = nextItems
    renderWindow.update(nextItems, preservingBoundary: preservesRenderWindow)
    if let readingPosition { renderWindow.include(readingPosition.messageID) }
    publishWindow()
  }

  private func requestFailureAccounts() {
    let id = pending.isEmpty ? history?.latestFailureID : nil
    guard let id, id != failureAccountsRequestedID else { return }
    failureAccountsTask?.cancel()
    failureAccountsRequestedID = id
    failureAccountsReadyID = nil
    failureBilling = nil
    failureBillingError = nil
    failureAccountsTask = Task { [weak self] in await self?.refreshFailureAccounts() }
  }

  private func publishWindow() {
    let next = Array(items[renderWindow.range])
    if visibleItems != next { visibleItems = next }
    hasEarlierMessages = renderWindow.hasEarlierMessages
    reconcileRunUsage()
  }

  private func reconcileRunUsage() {
    runUsage.update(
      runIDs: isVisible()
        ? visibleItems.compactMap {
          if case .usage(let runID) = $0 { return runID }
          return nil
        } : [], events: history?.usageEventIDs ?? [:])
  }

  private func persistPending() {
    do { try draftStorage?.save(pending, key: draftTarget.key + "/pending") } catch { show(error) }
  }

  private func show(_ failure: Error) {
    guard !closed else { return }
    error = failure.localizedDescription
    needsUpgrade = (failure as? APIClientError)?.statusCode == 426
    didFail(failure)
  }
}
