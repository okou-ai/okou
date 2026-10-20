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
  var thread: ChatThread
  var draft: String {
    get { composer.text }
    set { composer.text = newValue }
  }
  let composer: ComposerDraftStore
  var attachmentDraft: AttachmentDraftStore { composer.attachments }
  private let draftStorage: ChatDraftStorage?
  private let draftTarget: ChatDraftTarget
  @ObservationIgnored lazy var attachmentViewer = MessageAttachmentStore(
    commands: commands, didFail: didFail)
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
  private(set) var isLoading = false
  private(set) var isSending = false
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
  private let isVisible: @MainActor () -> Bool
  private let didMarkRead: @MainActor (Date?) -> Void
  private let didSend: @MainActor () -> Void
  private let didFail: @MainActor (Error) -> Void
  private let didSettle: @MainActor () -> Void
  private var refreshAgain = false
  private var refreshTask: Task<Void, Never>?
  private var sendTask: Task<Void, Never>?
  private var stopTask: Task<Void, Never>?
  private var expansionTask: Task<Void, Never>?
  private var renderWindow = ConversationRenderWindow()
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
    activitySleep: @escaping @Sendable (Duration) async throws -> Void = {
      try await Task.sleep(for: $0)
    },
    draftRepository: ChatDraftRepository? = nil, draftStorage: ChatDraftStorage? = nil
  ) {
    self.modelSelection = modelSelection
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
      if pending.contains(where: { $0.document == composer.value.draftUserMessage }),
        !pending.isEmpty
      {
        composer.clear()
      }
      rebuildMessages()
    } catch { show(error) }
  }

  var canRelease: Bool {
    (!composer.hasContent || composer.isDurable) && pending.isEmpty
      && modelSelection?.isBusy != true
      && !isLoading && !isSending && !isStopping && !isLoadingEarlier
      && history?.executionState.isActive != true
  }

  func refresh() async {
    guard !closed, !needsUpgrade, !Task.isCancelled else { return }
    composer.requestSync()
    if refreshTask != nil {
      refreshAgain = true
      return
    }
    isLoading = true
    let task = Task { [weak self] in
      guard let self else { return }
      defer {
        isLoading = false
        refreshTask = nil
        didSettle()
      }
      if history == nil, let cached = await sync.cachedHistory(threadID: thread.id) {
        await messageMarkdown.prepareLatest(cached.messages)
        guard !closed, !Task.isCancelled else { return }
        history = cached
        rebuildMessages()
      }
      repeat {
        refreshAgain = false
        do {
          let result = try await sync.history(threadID: thread.id)
          await messageMarkdown.prepareLatest(result.messages)
          try Task.checkCancellation()
          guard !closed else { return }
          if history != result { history = result }
          pending.removeAll { result.persistedEventIDs.contains($0.id) }
          rebuildMessages()
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
  func send(initialSelection: ChatModelSelection? = nil) async {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard composer.hasContent, composer.canSend, attachmentDraft.isReady,
      !isSending, !closed, !needsUpgrade, !Task.isCancelled
    else { return }
    guard initialSelection != nil || modelSelection?.canSend != false else { return }
    var message = PendingMessage(
      id: UUID().uuidString.lowercased(), text: text, createdAt: Date(),
      attachments: attachmentDraft.uploaded, document: composer.value.draftUserMessage)
    if let initialSelection {
      message.modelSelection = initialSelection
      message.reasoningEffort = modelSelection?.models.configuration?.requestedEffort(
        for: initialSelection)
    } else if modelSelection?.models.configuration != nil {
      message.modelSelection = modelSelection?.selection
      message.reasoningEffort = modelSelection?.requestedEffort
    }
    pending.append(message)
    rebuildMessages()
    composer.clear()
    composer.requestSync()
    await submit(message)
  }

  func retry(_ message: PendingMessage) async {
    await refresh()
    // An existing refresh must finish reconciliation before an explicit resubmission.
    if let refreshTask { await refreshTask.value }
    guard pending.contains(where: { $0.id == message.id }) else { return }
    await submit(message)
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
        _ = try await commands.send(
          thread: thread, text: message.text, attachments: message.attachments,
          document: message.document,
          clientEventID: message.id, modelSelection: message.modelSelection,
          reasoningEffort: message.reasoningEffort)
        try Task.checkCancellation()
        guard !closed else { return }
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
    } else {
      // A previous view can disappear after its replacement has already appeared.
      guard detailOwner == owner else { return }
      detailOwner = nil
      attachmentViewer.deactivate()
    }
    reconcileVisibility()
  }

  func reconcileVisibility() {
    reconcileActivitySummary()
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
    refreshTask?.cancel()
    sendTask?.cancel()
    stopTask?.cancel()
    expansionTask?.cancel()
    measurements.clear()
    composer.close()
    attachmentViewer.close()
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
    renderWindow.update(nextItems)
    if let readingPosition { renderWindow.include(readingPosition.messageID) }
    publishWindow()
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
