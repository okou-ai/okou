import Foundation
import Observation

@MainActor @Observable
final class WorkspaceStore {
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

  private let service: ChatService
  private let client: APIClient
  let webURL: URL
  private(set) var threads: [ChatThread] = []
  private(set) var histories: [String: ChatHistory] = [:]
  private(set) var pending: [String: [PendingMessage]] = [:]
  private(set) var loadingThreads: Set<String> = []
  private(set) var sendingThreads: Set<String> = []
  private(set) var stoppingThreads: Set<String> = []
  private(set) var isLoading = false
  private(set) var isCreating = false
  private(set) var needsUpgrade = false
  var error: String?
  var threadErrors: [String: String] = [:]
  var path: [String] = []
  var drafts: [String: String] = [:]
  var connectionStatus = "Connecting"
  private var realtime: RealtimeService?
  private var refreshAgain = false
  private var listRefreshAgain = false
  private var historyRefreshAgain: Set<String> = []
  private var refreshTask: Task<Void, Never>?
  private var closed = false
  private var isForeground = false

  init(client: APIClient, webURL: URL) {
    self.client = client
    self.service = ChatService(client: client)
    self.webURL = webURL
  }

  func start(userID: String, workspaceID: String) async {
    closed = false
    let realtime = RealtimeService(
      userID: userID, workspaceID: workspaceID,
      tokenProvider: { [client] in
        try await client.data("/api/realtime/token", method: "POST", body: Data("{}".utf8)).data
      },
      onChange: { [weak self] in self?.requestRefresh() },
      onConnection: { [weak self] status in self?.connectionStatus = status }
    )
    self.realtime = realtime
    realtime.start()
    await refresh()
  }

  func close() {
    closed = true
    refreshTask?.cancel()
    refreshTask = nil
    realtime?.stop()
    realtime = nil
  }

  func setForeground(_ active: Bool) {
    isForeground = active
  }

  func requestRefresh() {
    guard !closed, !needsUpgrade else { return }
    if refreshTask != nil {
      refreshAgain = true
      return
    }
    refreshTask = Task { [weak self] in
      guard let self else { return }
      repeat {
        refreshAgain = false
        await refresh()
      } while refreshAgain && !Task.isCancelled && !closed
      refreshTask = nil
    }
  }

  func refresh() async {
    guard !closed, !needsUpgrade else { return }
    if !isLoading {
      isLoading = true
      defer { isLoading = false }
      repeat {
        listRefreshAgain = false
        do {
          let result = try await service.threads()
          try Task.checkCancellation()
          guard !closed else { return }
          threads = result
          error = nil
        } catch is CancellationError {
        } catch { show(error) }
      } while listRefreshAgain && !closed && !Task.isCancelled && !needsUpgrade
    } else {
      listRefreshAgain = true
    }
    if let id = path.last { await loadHistory(id) }
  }

  func loadHistory(_ id: String) async {
    guard !closed, !needsUpgrade else { return }
    guard !loadingThreads.contains(id) else {
      historyRefreshAgain.insert(id)
      return
    }
    loadingThreads.insert(id)
    defer { loadingThreads.remove(id) }
    repeat {
      historyRefreshAgain.remove(id)
      do {
        let history = try await service.history(threadID: id)
        try Task.checkCancellation()
        guard !closed else { return }
        histories[id] = history
        let persisted = history.persistedEventIDs
        pending[id]?.removeAll { persisted.contains($0.id) }
        if pending[id]?.contains(where: \.needsRetry) != true { threadErrors[id] = nil }
        if isForeground, path.last == id,
          threads.first(where: { $0.id == id })?.indicator == .unread
        {
          try await service.markRead(threadID: id)
          guard !closed else { return }
          if let index = threads.firstIndex(where: { $0.id == id }),
            threads[index].indicator == .unread
          {
            threads[index].indicator = nil
          }
        }
      } catch is CancellationError {
      } catch { show(error, threadID: id) }
    } while historyRefreshAgain.contains(id) && !closed && !Task.isCancelled && !needsUpgrade
  }

  func createChat() async {
    guard !isCreating, !needsUpgrade, !closed else { return }
    isCreating = true
    defer { isCreating = false }
    do {
      let thread = try await service.createThread()
      try Task.checkCancellation()
      guard !closed else { return }
      // Realtime may publish the committed thread before its POST response arrives.
      if !threads.contains(where: { $0.id == thread.id }) { threads.insert(thread, at: 0) }
      if histories[thread.id] == nil { histories[thread.id] = .empty }
      path.append(thread.id)
      error = nil
    } catch is CancellationError {
    } catch { show(error) }
  }

  func send(in thread: ChatThread) async {
    let text = (drafts[thread.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, !sendingThreads.contains(thread.id), !needsUpgrade, !closed else { return }
    let message = PendingMessage(id: UUID().uuidString.lowercased(), text: text, createdAt: Date())
    pending[thread.id, default: []].append(message)
    drafts[thread.id] = ""
    await submit(message, in: thread)
  }

  func retry(_ message: PendingMessage, in thread: ChatThread) async {
    await loadHistory(thread.id)
    guard pending[thread.id]?.contains(where: { $0.id == message.id }) == true else { return }
    await submit(message, in: thread)
  }

  private func submit(_ message: PendingMessage, in thread: ChatThread) async {
    guard !sendingThreads.contains(thread.id), !closed, !needsUpgrade else { return }
    sendingThreads.insert(thread.id)
    defer { sendingThreads.remove(thread.id) }
    do {
      _ = try await service.send(thread: thread, text: message.text, clientEventID: message.id)
      guard !closed else { return }
      if let index = pending[thread.id]?.firstIndex(where: { $0.id == message.id }) {
        pending[thread.id]?[index].needsRetry = false
      }
      threadErrors[thread.id] = nil
      await loadHistory(thread.id)
      requestRefresh()
    } catch {
      guard !closed else { return }
      if let index = pending[thread.id]?.firstIndex(where: { $0.id == message.id }) {
        pending[thread.id]?[index].needsRetry = true
      }
      show(error, threadID: thread.id)
    }
  }

  func stop(_ thread: ChatThread) async {
    guard !stoppingThreads.contains(thread.id), !closed, !needsUpgrade else { return }
    stoppingThreads.insert(thread.id)
    defer { stoppingThreads.remove(thread.id) }
    do {
      try await service.stop(thread: thread)
      await loadHistory(thread.id)
    } catch { show(error, threadID: thread.id) }
  }

  func messages(for threadID: String) -> [ChatMessage] {
    let history = histories[threadID]?.messages ?? []
    let persisted = Set(history.map(\.id))
    return history + (pending[threadID] ?? []).filter { !persisted.contains($0.id) }.map(\.message)
  }

  private func show(_ error: Error, threadID: String? = nil) {
    guard !closed else { return }
    if let error = error as? APIClientError, error.statusCode == 426 {
      needsUpgrade = true
      realtime?.stop()
    }
    if let threadID {
      threadErrors[threadID] = error.localizedDescription
    } else {
      self.error = error.localizedDescription
    }
  }
}
