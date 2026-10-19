import ChatData
import ChatDomain
import Foundation
import Observation

/// Presentation and local delivery state for one conversation in one workspace.
@MainActor @Observable
final class ConversationStore {
  struct PendingMessage: Identifiable {
    let id: String
    let text: String
    let createdAt: Date
    let attachments: [ChatAttachment]
    var needsRetry = false

    var message: ChatMessage {
      ChatMessage(
        id: id, role: .user,
        text: ([text].filter { !$0.isEmpty }
          + attachments.map {
            "Attachment: \($0.filename) (open this chat on the website to view)"
          }).joined(separator: "\n"), createdAt: createdAt,
        runID: nil, isQueued: false, isError: false)
    }
  }

  var thread: ChatThread
  var draft = ""
  @ObservationIgnored lazy var attachmentDraft = AttachmentDraftStore(
    commands: commands, didFail: didFail)
  private(set) var history: ChatHistory?
  private(set) var pending: [PendingMessage] = []
  private(set) var messages: [ChatMessage] = []
  private(set) var visibleItems: [ConversationItem] = []
  var visibleMessages: [ChatMessage] { visibleItems.compactMap(\.message) }
  private(set) var hasEarlierMessages = false
  private(set) var isLoadingEarlier = false
  private(set) var readingPosition: ConversationReadingPosition?
  private(set) var isLoading = false
  private(set) var isSending = false
  private(set) var isStopping = false
  private(set) var error: String?
  private(set) var needsUpgrade = false
  let webURL: URL
  let messageMarkdown: MessageMarkdownCache
  let measurements = ConversationMeasurementCache()

  private let sync: ChatSync
  private let commands: ChatCommands
  private let isVisible: @MainActor () -> Bool
  private let didMarkRead: @MainActor () -> Void
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

  init(
    thread: ChatThread, sync: ChatSync, commands: ChatCommands,
    webURL: URL, messageMarkdown: MessageMarkdownCache,
    isVisible: @escaping @MainActor () -> Bool,
    didMarkRead: @escaping @MainActor () -> Void,
    didSend: @escaping @MainActor () -> Void,
    didFail: @escaping @MainActor (Error) -> Void,
    didSettle: @escaping @MainActor () -> Void
  ) {
    self.thread = thread
    self.sync = sync
    self.commands = commands
    self.webURL = webURL
    self.messageMarkdown = messageMarkdown
    self.isVisible = isVisible
    self.didMarkRead = didMarkRead
    self.didSend = didSend
    self.didFail = didFail
    self.didSettle = didSettle
  }

  var canRelease: Bool {
    draft.isEmpty && !attachmentDraft.hasAttachments && pending.isEmpty
      && !isLoading && !isSending && !isStopping && !isLoadingEarlier
      && history?.executionState.isActive != true
  }

  func refresh() async {
    guard !closed, !needsUpgrade, !Task.isCancelled else { return }
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
          if isVisible(), thread.indicator == .unread {
            try await commands.markRead(threadID: thread.id)
            guard !closed, !Task.isCancelled else { return }
            thread.indicator = nil
            didMarkRead()
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

  func send() async {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty || attachmentDraft.hasAttachments, attachmentDraft.isReady,
      !isSending, !closed, !needsUpgrade, !Task.isCancelled
    else { return }
    let message = PendingMessage(
      id: UUID().uuidString.lowercased(), text: text, createdAt: Date(),
      attachments: attachmentDraft.uploaded)
    pending.append(message)
    rebuildMessages()
    draft = ""
    attachmentDraft.reset()
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
    let task = Task { [weak self] in
      guard let self else { return }
      defer {
        isSending = false
        sendTask = nil
        didSettle()
      }
      do {
        _ = try await commands.send(
          thread: thread, text: message.text, attachments: message.attachments,
          clientEventID: message.id)
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

  func close() {
    closed = true
    refreshTask?.cancel()
    sendTask?.cancel()
    stopTask?.cancel()
    expansionTask?.cancel()
    measurements.clear()
    attachmentDraft.close()
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
    }
    guard items != nextItems else { return }
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
  }

  private func show(_ failure: Error) {
    guard !closed else { return }
    error = failure.localizedDescription
    needsUpgrade = (failure as? APIClientError)?.statusCode == 426
    didFail(failure)
  }
}
