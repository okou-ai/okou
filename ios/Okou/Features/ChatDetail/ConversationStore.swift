import Foundation
import Observation

/// Presentation and local delivery state for one conversation in one workspace.
@MainActor @Observable
final class ConversationStore {
  struct PendingMessage: Identifiable {
    let id: String
    let text: String
    let createdAt: Date
    var needsRetry = false

    var message: ChatMessage {
      ChatMessage(
        id: id, role: .user, text: text, createdAt: createdAt,
        runID: nil, isQueued: false, isError: false)
    }
  }

  var thread: ChatThread
  var draft = ""
  private(set) var history: ChatHistory?
  private(set) var pending: [PendingMessage] = []
  private(set) var isLoading = false
  private(set) var isSending = false
  private(set) var isStopping = false
  private(set) var error: String?
  private(set) var needsUpgrade = false
  let webURL: URL
  let messageMarkdown: MessageMarkdownCache

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

  var messages: [ChatMessage] {
    let persisted = history?.persistedEventIDs ?? []
    return (history?.messages ?? []) + pending.filter { !persisted.contains($0.id) }.map(\.message)
  }

  var canRelease: Bool {
    draft.isEmpty && pending.isEmpty && !isLoading && !isSending && !isStopping
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
    guard !text.isEmpty, !isSending, !closed, !needsUpgrade, !Task.isCancelled else { return }
    let message = PendingMessage(id: UUID().uuidString.lowercased(), text: text, createdAt: Date())
    pending.append(message)
    draft = ""
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
        _ = try await commands.send(thread: thread, text: message.text, clientEventID: message.id)
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
  }

  private func show(_ failure: Error) {
    guard !closed else { return }
    error = failure.localizedDescription
    needsUpgrade = (failure as? APIClientError)?.statusCode == 426
    didFail(failure)
  }
}
