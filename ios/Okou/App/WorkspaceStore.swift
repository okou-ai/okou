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
  private(set) var agents: [AgentRecord] = []
  private(set) var pinnedAgentIDs: [String] = []
  private(set) var canArchiveChats = false
  private(set) var navigationError: String?
  private(set) var histories: [String: ChatHistory] = [:]
  private(set) var pending: [String: [PendingMessage]] = [:]
  private(set) var loadingThreads: Set<String> = []
  private(set) var sendingThreads: Set<String> = []
  private(set) var stoppingThreads: Set<String> = []
  private(set) var updatingThreads: Set<String> = []
  private(set) var isLoading = false
  private(set) var isCreating = false
  private(set) var needsUpgrade = false
  var error: String?
  var threadErrors: [String: String] = [:]
  var selectedThreadID: String?
  var selectedAgentID: String?
  var newChatDraft = ""
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
    await refreshNavigation()
    await refresh()
  }

  func refreshNavigation() async {
    guard !closed, !needsUpgrade else { return }
    do {
      let result: [AgentRecord] = try await client.request("/api/agents")
      guard !closed else { return }
      agents = result
      if selectedAgentID == nil { selectedAgentID = result.first(where: \.isDefaultAgent)?.agentId }
      let preferences: SidebarPreferences = try await client.request("/api/user-preferences")
      guard !closed else { return }
      pinnedAgentIDs = preferences.pinnedAgentIds
      navigationError = nil
    } catch let error as APIClientError where error.statusCode == 409 {
      pinnedAgentIDs = []
      navigationError = nil
    } catch {
      navigationError = error.localizedDescription
    }
    let switches: SidebarFeatureSwitches? = try? await client.request("/api/feature-switches")
    guard !closed else { return }
    canArchiveChats = switches?.effectiveSwitches["chatThreadArchiving"] == true
  }

  var visiblePinnedAgents: [AgentRecord] {
    let defaultID = agents.first(where: \.isDefaultAgent)?.agentId
    let ids = [defaultID].compactMap { $0 } + pinnedAgentIDs.filter { $0 != defaultID }
    return ids.compactMap { id in agents.first(where: { $0.agentId == id }) }
  }

  var currentAgentName: String {
    agents.first(where: { $0.agentId == selectedAgentID })?.displayName ?? "Okou"
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
          if let selectedThreadID, !result.contains(where: { $0.id == selectedThreadID }) {
            self.selectedThreadID = nil
          }
          error = nil
        } catch is CancellationError {
        } catch { show(error) }
      } while listRefreshAgain && !closed && !Task.isCancelled && !needsUpgrade
    } else {
      listRefreshAgain = true
    }
    if let id = selectedThreadID { await loadHistory(id) }
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
        if isForeground, selectedThreadID == id,
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

  func createChat(agentID: String? = nil) async {
    guard !isCreating, !needsUpgrade, !closed else { return }
    isCreating = true
    defer { isCreating = false }
    do {
      let thread = try await service.createThread(agentID: agentID)
      try Task.checkCancellation()
      guard !closed else { return }
      // Realtime may publish the committed thread before its POST response arrives.
      if !threads.contains(where: { $0.id == thread.id }) { threads.insert(thread, at: 0) }
      if histories[thread.id] == nil { histories[thread.id] = .empty }
      selectedThreadID = thread.id
      selectedAgentID = thread.agentID
      error = nil
    } catch is CancellationError {
    } catch { show(error) }
  }

  func selectChat(_ id: String) {
    guard let thread = threads.first(where: { $0.id == id }) else { return }
    selectedThreadID = thread.id
    selectedAgentID = thread.agentID
  }

  func startNewChat(agentID: String? = nil) {
    guard !isCreating, !needsUpgrade, !closed else { return }
    selectedThreadID = nil
    selectedAgentID = agentID ?? selectedAgentID ?? agents.first(where: \.isDefaultAgent)?.agentId
    newChatDraft = ""
    error = nil
  }

  func sendNewChat() async {
    let text = newChatDraft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, selectedThreadID == nil, !isCreating, !needsUpgrade, !closed else {
      return
    }
    await createChat(agentID: selectedAgentID)
    guard let id = selectedThreadID, let thread = threads.first(where: { $0.id == id }) else {
      return
    }
    drafts[id] = text
    newChatDraft = ""
    await send(in: thread)
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

  func setPinned(_ thread: ChatThread, pinned: Bool) async {
    await updateThread(thread.id) {
      try await service.setPinned(threadID: thread.id, pinned: pinned)
    }
  }

  func setArchived(_ thread: ChatThread, archived: Bool) async {
    await updateThread(thread.id) {
      try await service.setArchived(threadID: thread.id, archived: archived)
    }
  }

  func rename(_ thread: ChatThread, title: String) async {
    let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    await updateThread(thread.id) { try await service.rename(threadID: thread.id, title: trimmed) }
  }

  private func updateThread(_ id: String, command: () async throws -> Void) async {
    guard !updatingThreads.contains(id), !needsUpgrade, !closed else { return }
    updatingThreads.insert(id)
    defer { updatingThreads.remove(id) }
    do {
      try await command()
      await refresh()
    } catch { show(error) }
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
