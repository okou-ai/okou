import ChatDomain
import Foundation
import Observation

/// Navigation data and list presentation for one workspace.
@MainActor @Observable
final class ThreadListStore {
  private(set) var threads: [ChatThread] = []
  private(set) var agents: [AgentRecord] = []
  private(set) var pinnedAgentIDs: [String] = []
  private(set) var canArchiveChats = false
  private(set) var navigationError: String?
  private(set) var error: String?
  private(set) var isLoading = false
  private(set) var updatingThreads: Set<String> = []
  private let client: APIClient
  private let sync: ChatSync
  private let commands: ChatCommands
  private let didRefresh: @MainActor ([ChatThread]) -> Void
  private let didFail: @MainActor (Error) -> Void
  private var refreshAgain = false
  private var refreshTask: Task<Void, Never>?
  private var navigationTask: Task<Void, Never>?
  private var updateTasks: [String: Task<Void, Never>] = [:]
  private var closed = false
  private var blocked = false

  init(
    client: APIClient, sync: ChatSync, commands: ChatCommands,
    didRefresh: @escaping @MainActor ([ChatThread]) -> Void,
    didFail: @escaping @MainActor (Error) -> Void
  ) {
    self.client = client
    self.sync = sync
    self.commands = commands
    self.didRefresh = didRefresh
    self.didFail = didFail
  }

  func restoreCached() async {
    guard !closed, !Task.isCancelled else { return }
    if let cached = await sync.cachedThreads() {
      guard !closed, !Task.isCancelled else { return }
      threads = cached
      didRefresh(cached)
    }
  }

  func refreshNavigation() async {
    guard !closed, !blocked, !Task.isCancelled else { return }
    if let navigationTask {
      await navigationTask.value
      return
    }
    let task = Task { [weak self] in
      guard let self else { return }
      defer { navigationTask = nil }
      await loadNavigation()
    }
    navigationTask = task
    await withTaskCancellationHandler {
      await task.value
    } onCancel: {
      task.cancel()
    }
  }

  private func loadNavigation() async {
    guard !closed, !blocked, !Task.isCancelled else { return }
    do {
      let result: [AgentRecord] = try await client.request("/api/agents")
      guard !closed, !Task.isCancelled else { return }
      agents = result
      let preferences: SidebarPreferences = try await client.request("/api/user-preferences")
      guard !closed, !Task.isCancelled else { return }
      pinnedAgentIDs = preferences.pinnedAgentIds
      navigationError = nil
    } catch is CancellationError {
      return
    } catch let error as APIClientError where error.statusCode == 409 {
      guard !closed, !Task.isCancelled else { return }
      pinnedAgentIDs = []
      navigationError = nil
    } catch {
      guard !closed, !Task.isCancelled else { return }
      navigationError = error.localizedDescription
      didFail(error)
    }
    guard !closed, !blocked, !Task.isCancelled else { return }
    let switches: SidebarFeatureSwitches?
    do {
      switches = try await client.request("/api/feature-switches")
    } catch {
      guard !closed, !Task.isCancelled else { return }
      didFail(error)
      switches = nil
    }
    guard !closed, !Task.isCancelled else { return }
    canArchiveChats = switches?.effectiveSwitches["chatThreadArchiving"] == true
  }

  var visiblePinnedAgents: [AgentRecord] {
    let defaultID = agents.first(where: \.isDefaultAgent)?.agentId
    let ids = [defaultID].compactMap { $0 } + pinnedAgentIDs.filter { $0 != defaultID }
    return ids.compactMap { id in agents.first(where: { $0.agentId == id }) }
  }

  func refresh() async {
    guard !closed, !blocked, !Task.isCancelled else { return }
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
      }
      repeat {
        refreshAgain = false
        do {
          let result = try await sync.threads()
          try Task.checkCancellation()
          guard !closed else { return }
          if threads != result { threads = result }
          didRefresh(result)
          error = nil
        } catch is CancellationError {
          return
        } catch { show(error) }
      } while refreshAgain && !closed && !blocked && !Task.isCancelled
    }
    refreshTask = task
    await task.value
  }

  func insertCreated(_ thread: ChatThread) {
    // Realtime can publish a committed thread before its POST response arrives.
    if !threads.contains(where: { $0.id == thread.id }) { threads.insert(thread, at: 0) }
  }

  func markRead(_ id: String) {
    if let index = threads.firstIndex(where: { $0.id == id }), threads[index].indicator == .unread {
      threads[index].indicator = nil
    }
  }

  func refreshIndicators() async {
    guard !closed, !blocked, !Task.isCancelled else { return }
    do {
      let result = try await sync.indicators()
      try Task.checkCancellation()
      guard !closed else { return }
      threads = threads.map { thread in
        var updated = thread
        updated.indicator = result.threads[thread.id]
        return updated
      }
      didRefresh(threads)
    } catch is CancellationError {
    } catch { didFail(error) }
  }

  func setPinned(_ thread: ChatThread, pinned: Bool) async {
    await updateThread(thread.id) { [commands] in
      try await commands.setPinned(threadID: thread.id, pinned: pinned)
    }
  }

  func setArchived(_ thread: ChatThread, archived: Bool) async {
    await updateThread(thread.id) { [commands] in
      try await commands.setArchived(threadID: thread.id, archived: archived)
    }
  }

  func rename(_ thread: ChatThread, title: String) async {
    let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    await updateThread(thread.id) { [commands] in
      try await commands.rename(threadID: thread.id, title: trimmed)
    }
  }

  private func updateThread(_ id: String, command: @escaping @MainActor () async throws -> Void)
    async
  {
    guard !updatingThreads.contains(id), !closed, !blocked, !Task.isCancelled else { return }
    updatingThreads.insert(id)
    let task = Task { [weak self] in
      guard let self else { return }
      defer {
        updatingThreads.remove(id)
        updateTasks[id] = nil
      }
      do {
        try await command()
        try Task.checkCancellation()
        guard !closed else { return }
        await refresh()
      } catch is CancellationError {
      } catch { show(error) }
    }
    updateTasks[id] = task
    await task.value
  }

  func close() {
    closed = true
    refreshTask?.cancel()
    navigationTask?.cancel()
    for task in updateTasks.values { task.cancel() }
  }

  private func show(_ failure: Error) {
    guard !closed else { return }
    error = failure.localizedDescription
    blocked = (failure as? APIClientError)?.statusCode == 426
    didFail(failure)
  }
}
