import CCState
import ChatData
import ChatDomain
import Foundation

/// Owns a conversation's shared history/read work and disposable native presentation window.
@MainActor
final class ConversationPresentation {
  typealias PendingMessage = ConversationStore.PendingMessage
  typealias NavigationRequest = ConversationStore.NavigationRequest
  private weak var conversation: ConversationStore?
  private let projection: ConversationProjection
  private let sync: ChatSync
  private let commands: ChatCommands
  private let readResources: ConversationReadResources
  private let lifecycleTasks: LifecycleTasks
  private let liveOutput: ConversationLiveOutput
  private let messageMarkdown: MessageMarkdownCache
  private let composer: ComposerDraftStore
  private let activitySummary: ConversationActivitySummary
  private let runUsage: ConversationRunUsageStore
  private let isClosed: @MainActor () -> Bool
  private let isVisible: @MainActor () -> Bool
  private let didMarkRead: @MainActor (Date?) -> Void
  private let didSettle: @MainActor () -> Void
  private let confirmHistory: @MainActor (ChatHistory?) -> Void
  private let replacePending: @MainActor ([PendingMessage]) -> Void
  private let didReconcileProjection: @MainActor () -> Void
  private let clearStopIssue: @MainActor () -> Void
  private let cancelRecoverySend: @MainActor () -> Void
  private let report: @MainActor (Error) -> Void
  private var closed: Bool { isClosed() }
  private var needsUpgrade: Bool { conversation?.needsUpgrade != false }
  private var items: [ConversationItem] { projection.items }
  private var messages: [ChatMessage] { projection.messages }
  private var history: ChatHistory? {
    get { projection.history }
    set { confirmHistory(newValue) }
  }
  private var pending: [PendingMessage] {
    get { projection.pending }
    set { replacePending(newValue) }
  }
  init(
    conversation: ConversationStore, projection: ConversationProjection, sync: ChatSync,
    commands: ChatCommands, reads: ConversationReadResources, lifecycleTasks: LifecycleTasks,
    liveOutput: ConversationLiveOutput, isClosed: @escaping @MainActor () -> Bool,
    isVisible: @escaping @MainActor () -> Bool, didMarkRead: @escaping @MainActor (Date?) -> Void,
    didSettle: @escaping @MainActor () -> Void,
    confirmHistory: @escaping @MainActor (ChatHistory?) -> Void,
    replacePending: @escaping @MainActor ([PendingMessage]) -> Void,
    reconcileProjection: @escaping @MainActor () -> Void,
    clearStopIssue: @escaping @MainActor () -> Void,
    cancelRecoverySend: @escaping @MainActor () -> Void,
    report: @escaping @MainActor (Error) -> Void
  ) {
    self.conversation = conversation
    self.projection = projection
    self.sync = sync
    self.commands = commands
    readResources = reads
    self.lifecycleTasks = lifecycleTasks
    self.liveOutput = liveOutput
    messageMarkdown = conversation.messageMarkdown
    composer = conversation.composer
    activitySummary = conversation.activitySummary
    runUsage = conversation.runUsage
    self.isClosed = isClosed
    self.isVisible = isVisible
    self.didMarkRead = didMarkRead
    self.didSettle = didSettle
    self.confirmHistory = confirmHistory
    self.replacePending = replacePending
    didReconcileProjection = reconcileProjection
    self.clearStopIssue = clearStopIssue
    self.cancelRecoverySend = cancelRecoverySend
    self.report = report
    let readingState = readingState
    window = Computed { get in try get(readingState).window }
    navigation = Computed { get in
      let reading = try get(readingState)
      return Navigation(readingMessageID: reading.position?.messageID, request: reading.request)
    }
    loadsEarlier = Computed { get in try get(readingState).isLoadingEarlier }
    let syncState = syncState
    syncStatus = Computed { get in try get(syncState) }
  }
  private func reconcileProjection() { didReconcileProjection() }
  func waitForRefresh() async {
    if let refreshTask { await refreshTask.value }
  }
  func close() {
    refreshTask?.cancel()
    readTask?.cancel()
    expansionTask?.cancel()
  }

  /// The render window, the reading position and the latest reveal request, kept in the
  /// workspace session's Store. ChatDetailView reads `window` and `navigation`, and the earlier
  /// messages row reads `loadsEarlier`, through CCStateSwiftUI; the accessors in the extension
  /// below serve owner logic and tests.
  let window: Computed<Window>
  let navigation: Computed<Navigation>
  let loadsEarlier: Computed<Bool>
  private let readingState = CCState.State(Reading())
  private(set) var detailOwner: UUID?
  /// History and read-mark synchronization, kept in the workspace session's Store.
  /// ChatDetailView and the chat list's sync status read `syncStatus` through CCStateSwiftUI.
  let syncStatus: Computed<SyncStatus>
  private let syncState = CCState.State(SyncStatus())
  private(set) var readSyncError: String? {
    get { currentSyncStatus.readError }
    set { updateSync { $0.readError = newValue } }
  }
  private(set) var historySyncError: String? {
    get { currentSyncStatus.historyError }
    set { updateSync { $0.historyError = newValue } }
  }
  private var refreshAgain = false
  private var refreshTask: Task<Void, Never>? {
    didSet { updateSync { $0.isRefreshing = refreshTask != nil } }
  }
  private var readTask: Task<Void, Never>? {
    didSet { updateSync { $0.isMarkingRead = readTask != nil } }
  }
  private var readAgain = false
  private var refreshGeneration = UUID()
  private var expansionTask: Task<Void, Never>?
  private var renderWindow = ConversationRenderWindow()
  private var preservesRenderWindow = false
  private var suppressAutomaticRead = false
  private var manualUnreadThrough: Date?
  private var locallyReadThrough: Date?
  var isLoading: Bool { currentSyncStatus.isLoading }

  func restoreCached() async {
    guard let thread = conversation?.thread else { return }
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
    history = cached.withCancellationRecoveryPending(history?.executionState == .recovering)
    pending.removeAll { cached.persistedEventIDs.contains($0.id) }
    reconcileProjection()
  }

  func refresh(waitForCurrent: Bool = false) async {
    guard !closed, !needsUpgrade, !Task.isCancelled else { return }
    if let refreshTask {
      refreshAgain = true
      if waitForCurrent { await refreshTask.value }
      return
    }
    let generation = refreshGeneration
    let task = Task { [weak self, weak conversation = conversation] in
      guard let self, let conversation else { return }
      defer { withExtendedLifetime(conversation) {} }
      defer {
        if refreshGeneration == generation {
          refreshTask = nil
        }
        didSettle()
      }
      guard !Task.isCancelled, refreshGeneration == generation else { return }
      await restoreCached()
      guard !closed, !Task.isCancelled, refreshGeneration == generation else { return }
      repeat {
        refreshAgain = false
        do {
          let reads = try readResources.refresh()
          // Both original reads belong to this refresh cycle.
          defer { reads.cancel() }
          let events: ChatHistory
          do {
            events = try await reads.history.value
          } catch let error as APIClientError where error.isResourceNotFound {
            // A history subresource can be missing. Let the parallel parent read confirm it.
            _ = try await reads.recovery.value
            throw error
          }
          // Keep a confirmed recovery visible until its independent read finishes.
          let result = events.withCancellationRecoveryPending(
            history?.executionState == .recovering)
          await messageMarkdown.prepareLatest(result.messages)
          try Task.checkCancellation()
          guard !closed, refreshGeneration == generation else { return }
          if history != result { history = result }
          pending.removeAll { result.persistedEventIDs.contains($0.id) }
          reconcileProjection()
          let recovering = try await reads.recovery.value
          try Task.checkCancellation()
          guard !closed, refreshGeneration == generation else { return }
          let verified = events.withCancellationRecoveryPending(recovering)
          if history != verified { history = verified }
          historySyncError = nil
          if !result.canStop { clearStopIssue() }
          await markVisibleDeliveryRead()
        } catch is CancellationError {
          return
        } catch {
          guard !Task.isCancelled, refreshGeneration == generation else { return }
          historySyncError = error.localizedDescription
          report(error)
        }
      } while refreshAgain && !closed && !needsUpgrade && !Task.isCancelled
    }
    lifecycleTasks.track(task)
    refreshTask = task
    await task.value
  }

  /// Revisit an indicator watermark without fetching history again. A resident
  /// refresh still owns its history/recovery confirmation before this decision.
  func reconcileReadState() async {
    let generation = refreshGeneration
    if let refreshTask { await refreshTask.value }
    guard !closed, !needsUpgrade, !Task.isCancelled, refreshGeneration == generation,
      readSyncError == nil
    else { return }
    await markVisibleDeliveryRead()
  }

  func markVisibleDeliveryRead() async {
    guard !closed, !needsUpgrade, !Task.isCancelled, history != nil, historySyncError == nil else {
      return
    }
    if let readTask {
      readAgain = true
      await readTask.value
      return
    }
    let generation = refreshGeneration
    let task = Task { [weak self, weak conversation = conversation] in
      guard let self, let conversation else { return }
      defer { withExtendedLifetime(conversation) {} }
      defer {
        if refreshGeneration == generation { readTask = nil }
        didSettle()
      }
      repeat {
        let thread = conversation.thread
        guard !closed, !needsUpgrade, !Task.isCancelled, refreshGeneration == generation else {
          return
        }
        readAgain = false
        let unreadThrough = [history?.latestRunFinishAt, thread.unreadAt].compactMap { $0 }.max()
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
          do {
            let watermark = try await commands.markRead(threadID: thread.id)
            guard !closed, !Task.isCancelled, refreshGeneration == generation else { return }
            readSyncError = nil
            if let watermark {
              locallyReadThrough = max(locallyReadThrough ?? watermark, watermark)
              if suppressAutomaticRead {
                manualUnreadThrough = max(manualUnreadThrough ?? watermark, watermark)
              }
            }
            if !suppressAutomaticRead { didMarkRead(watermark) }
          } catch {
            guard !closed, !Task.isCancelled, refreshGeneration == generation,
              !(error is CancellationError)
            else { return }
            readSyncError = error.localizedDescription
            report(error)
            return
          }
        } else {
          readSyncError = nil
        }
      } while readAgain && !closed && !needsUpgrade && !Task.isCancelled
    }
    lifecycleTasks.track(task)
    readTask = task
    await task.value
  }

  func setAutomaticReadSuppressed(_ suppressed: Bool, resetReadWatermark: Bool = false) {
    guard let thread = conversation?.thread else { return }
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

  func setDetailVisible(_ visible: Bool, owner: UUID) {
    guard let conversation else { return }
    if visible {
      if detailOwner != owner {
        conversation.failureRecoveryActions.retireContext()
      }
      conversation.failureRecoveryActions.enableReads()
      detailOwner = owner
      conversation.permissionActions.activate(owner: owner)
      conversation.approvals.activate()
      composer.requestSync()
    } else {
      // A previous view can disappear after its replacement has already appeared.
      guard detailOwner == owner else { return }
      detailOwner = nil
      conversation.attachmentViewer.deactivate()
      conversation.artifacts.deactivate()
      conversation.failureRecoveryActions.deactivate()
      if conversation.isRecoveringFailure { cancelRecoverySend() }
      conversation.permissionActions.deactivate()
      conversation.approvals.deactivate()
    }
    conversation.reconcileVisibility()
  }

  func reconcileVisibility() {
    guard let conversation else { return }
    reconcileActivitySummary()
    if detailOwner != nil && isVisible() {
      conversation.failureRecoveryActions.requestFailureAccounts()
    }
    reconcileRunUsage()
  }

  func reconcileActivitySummary() {
    let history = projection.currentValue.history
    activitySummary.demand(
      !closed && !needsUpgrade && detailOwner != nil && isVisible()
        && history?.executionState == .running ? history?.activityRunID : nil)
    reconcileStreaming()
  }

  /// Follows the visible chat's running run; like the web, a chunk 0 starts a message,
  /// later chunks append, and the persisted event with the same id always wins.
  private func reconcileStreaming() {
    let history = projection.currentValue.history
    let runID =
      !closed && !needsUpgrade && detailOwner != nil && isVisible()
        && history?.executionState == .running ? history?.activityRunID?.lowercased() : nil
    liveOutput.reconcile(runID: runID, subscribe: conversation?.runOutput)
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
    updateReading { $0.position = position }
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
    updateReading { $0.request = NavigationRequest(position: position) }
    return true
  }

  func earlierWindowMessages() -> [ChatMessage] {
    var expanded = renderWindow
    expanded.expand()
    return items[expanded.range.lowerBound..<renderWindow.range.lowerBound].compactMap(\.message)
  }

  func loadEarlierMessages() async {
    guard !closed, !needsUpgrade, !Task.isCancelled, hasEarlierMessages, expansionTask == nil else {
      return
    }
    updateReading { $0.isLoadingEarlier = true }
    let task = Task { [weak self, weak conversation = conversation] in
      guard let self, let conversation else { return }
      defer { withExtendedLifetime(conversation) {} }
      defer {
        expansionTask = nil
        updateReading { $0.isLoadingEarlier = false }
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
    lifecycleTasks.track(task)
    expansionTask = task
    await task.value
  }

  func resetRenderWindowToLatest() {
    guard !closed else { return }
    expansionTask?.cancel()
    updateReading { $0.position = nil }
    renderWindow.resetToLatest()
    publishWindow()
  }

  func preserveRenderWindow() { preservesRenderWindow = true }

  // Release without changing coordinates during cancellation or a native keyboard animation.
  // The next projection update can advance the boundary, unless history reading has resumed.
  func releaseRenderWindow() { preservesRenderWindow = false }

  private func publishWindow() {
    let next = Window(
      items: Array(items[renderWindow.range]), hasEarlierMessages: renderWindow.hasEarlierMessages)
    updateReading { $0.window = next }
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

  func artifactGroup(for messageID: String) -> MessageArtifactGroup? {
    guard let index = items.firstIndex(where: { $0.id == messageID }) else { return nil }
    var start = index
    while start > 0, !items[start].beginsWorkSection, items[start - 1].role == items[index].role {
      start -= 1
    }
    var end = index + 1
    while end < items.count, !items[end].beginsWorkSection, items[end].role == items[index].role {
      end += 1
    }
    return MessageArtifactGroup(
      id: items[start].id, sources: items[start..<end].compactMap(\.message).map(\.text))
  }

  func cancelRefresh() {
    refreshGeneration = UUID()
    refreshTask?.cancel()
    refreshTask = nil
    readTask?.cancel()
    readTask = nil
    readAgain = false
    readResources.pause()
    refreshAgain = false
  }
  func reconcileWindow() {
    let nextItems = items
    let position = renderWindow.rebased(readingPosition, to: nextItems)
    guard renderWindow.update(nextItems, preservingBoundary: preservesRenderWindow) else {
      reconcileRunUsage()
      return
    }
    updateReading { $0.position = position }
    if let position { renderWindow.include(position.messageID) }
    publishWindow()
  }
}

extension ConversationPresentation {
  /// The rows the transcript renders, and whether earlier groups exist above them.
  struct Window: Equatable {
    var items: [ConversationItem] = []
    var hasEarlierMessages = false
  }

  /// What the scroll coordinator follows: the remembered reading row and the latest explicit
  /// reveal. An offset change alone does not change it, so ordinary scrolling does not render
  /// the transcript view again.
  struct Navigation: Equatable {
    var readingMessageID: String?
    var request: NavigationRequest?
  }

  /// The graph state behind `window`, `navigation` and `loadsEarlier`.
  fileprivate struct Reading: Equatable {
    var window = Window()
    var isLoadingEarlier = false
    var position: ConversationReadingPosition?
    var request: NavigationRequest?
  }

  var currentWindow: Window { currentReading.window }
  var currentNavigation: Navigation {
    let reading = currentReading
    return Navigation(readingMessageID: reading.position?.messageID, request: reading.request)
  }
  var visibleItems: [ConversationItem] { currentReading.window.items }
  var hasEarlierMessages: Bool { currentReading.window.hasEarlierMessages }
  var isLoadingEarlier: Bool { currentReading.isLoadingEarlier }
  var readingPosition: ConversationReadingPosition? { currentReading.position }
  var navigationRequest: NavigationRequest? { currentReading.request }

  private var currentReading: Reading {
    do { return try projection.store.get(readingState) } catch {
      preconditionFailure("Cannot read the conversation reading graph: \(error)")
    }
  }

  /// History and read-mark synchronization: whether either is in flight, and their last errors.
  struct SyncStatus: Equatable {
    var isRefreshing = false
    var isMarkingRead = false
    var historyError: String?
    var readError: String?

    var isLoading: Bool { isRefreshing || isMarkingRead }
    /// The error the chat list's sync status reports.
    var error: String? { historyError ?? readError }
  }

  /// The answer for a reader without a conversation.
  static let idleSync = Computed { _ in SyncStatus() }

  var currentSyncStatus: SyncStatus {
    do { return try projection.store.get(syncState) } catch {
      preconditionFailure("Cannot read the conversation sync status: \(error)")
    }
  }

  fileprivate func updateSync(_ mutation: (inout SyncStatus) -> Void) {
    let previous = currentSyncStatus
    var next = previous
    mutation(&next)
    guard next != previous else { return }
    do { try projection.store.set(syncState, next) } catch {
      preconditionFailure("Cannot update the conversation sync status: \(error)")
    }
  }

  fileprivate func updateReading(_ mutation: (inout Reading) -> Void) {
    let previous = currentReading
    var next = previous
    mutation(&next)
    guard next != previous else { return }
    do { try projection.store.set(readingState, next) } catch {
      preconditionFailure("Cannot update the conversation reading graph: \(error)")
    }
  }
}
