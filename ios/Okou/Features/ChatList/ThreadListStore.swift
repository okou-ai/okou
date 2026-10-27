import ChatData
import ChatDomain
import Foundation
import Observation

/// Navigation data and list presentation for one workspace.
@MainActor @Observable
final class ThreadListStore {
  private(set) var threads: [ChatThread] = []
  private(set) var agents: [AgentRecord] = []
  private(set) var pinnedAgentIDs: [String] = []
  private(set) var unreadAgentIDs: Set<String> = []
  private(set) var canUseComposerConnectors = false
  private var archivingEnabled: Bool?
  var canArchiveChats: Bool { archivingEnabled == true }
  private(set) var canMuteChats = false
  var onlyUnread = false
  private(set) var markingAgentRead = false
  private var readRevision = 0
  private(set) var navigationError: String?
  private(set) var actionError: String?
  private(set) var refreshError: String?
  private var indicatorsError: String?
  var syncError: String? { refreshError ?? indicatorsError }
  var error: String? { actionError ?? syncError }
  private(set) var isLoading = false
  private(set) var hasLoadedThreads = false
  private(set) var updatingThreads: Set<String> = []
  private let client: APIClient
  private let sync: ChatSync
  private let commands: ChatCommands
  private let didRefresh: @MainActor ([ChatThread]) -> Void
  private let didFail: @MainActor (Error) -> Void
  private let readRetrySleep: @Sendable (Duration) async throws -> Void
  private var refreshAgain = false
  private var indicatorsAgain = false
  private var refreshGeneration = UUID()
  private var creationRevision = 0
  private var refreshTask: Task<Void, Never>?
  private var navigationTask: Task<Void, Never>?
  private var navigationRevision = 0
  private var restoredNavigation = false
  private var indicatorsTask: Task<Void, Never>?
  private var updateTasks: [String: Task<Void, Never>] = [:]
  private var pinTasks: [String: Task<Void, Never>] = [:]
  private var lastPinIDs: [String: String] = [:]
  private var optimisticChanges: [(id: String, change: ChatThreadChange)] = []
  struct RenameRequest: Identifiable {
    let id: UUID
    let threadID: String
    var error: String?
  }
  private(set) var renameRequest: RenameRequest?
  private(set) var isSavingRename = false
  var renameTitle = ""
  private var renameSessionID = UUID()
  private var closed = false
  private var blocked = false

  init(
    client: APIClient, sync: ChatSync, commands: ChatCommands,
    didRefresh: @escaping @MainActor ([ChatThread]) -> Void,
    didFail: @escaping @MainActor (Error) -> Void,
    readRetrySleep: @escaping @Sendable (Duration) async throws -> Void = {
      try await Task.sleep(for: $0)
    }
  ) {
    self.client = client
    self.sync = sync
    self.commands = commands
    self.didRefresh = didRefresh
    self.didFail = didFail
    self.readRetrySleep = readRetrySleep
  }

  func restoreCached(threadID: String? = nil) async {
    guard !closed, !Task.isCancelled else { return }
    if !restoredNavigation, navigationRevision == 0 {
      let revision = navigationRevision
      let cached = await sync.cachedNavigation()
      guard !closed, !Task.isCancelled else { return }
      if let cached, !restoredNavigation, navigationRevision == revision {
        agents = cached.agents
        pinnedAgentIDs = cached.preferences.pinnedAgentIds
        applySwitches(cached.featureSwitches)
      }
      restoredNavigation = true
    }
    if hasLoadedThreads {
      // A notification can cache a newly created chat after this list was mounted.
      if let threadID, !threads.contains(where: { $0.id == threadID }),
        let cached = await sync.cachedThreads(),
        let thread = cached.first(where: { $0.id == threadID }),
        !closed, !Task.isCancelled, !threads.contains(where: { $0.id == threadID })
      {
        projectThreads(threads + [thread])
      }
      return
    }
    guard !closed, !Task.isCancelled else { return }
    let revision = creationRevision
    if let cached = await sync.cachedThreads() {
      guard !closed, !hasLoadedThreads, !Task.isCancelled, revision == creationRevision else {
        return
      }
      projectThreads(cached)
    }
  }

  func refreshNavigation() async {
    guard !closed, !blocked, !Task.isCancelled else { return }
    await restoreCached()
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
    navigationRevision += 1
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
    let switches: SidebarFeatureSwitches
    do {
      switches = try await client.request("/api/feature-switches")
    } catch {
      guard !closed, !Task.isCancelled else { return }
      didFail(error)
      return
    }
    guard !closed, !Task.isCancelled else { return }
    // Keep this workspace's last successful flags until a new response replaces them.
    applySwitches(switches)
    if navigationError == nil {
      await sync.persistNavigation(
        SidebarNavigationSnapshot(
          agents: agents, preferences: SidebarPreferences(pinnedAgentIds: pinnedAgentIDs),
          featureSwitches: switches))
    }
  }

  private func applySwitches(_ switches: SidebarFeatureSwitches) {
    canUseComposerConnectors = switches.effectiveSwitches["iosComposerConnectors"] == true
    archivingEnabled = switches.effectiveSwitches["chatThreadArchiving"] == true
    canMuteChats = switches.effectiveSwitches["chatThreadMuting"] == true
  }

  var visiblePinnedAgents: [AgentRecord] {
    let defaultID = agents.first(where: \.isDefaultAgent)?.agentId
    let ids = [defaultID].compactMap { $0 } + pinnedAgentIDs.filter { $0 != defaultID }
    return ids.compactMap { id in agents.first(where: { $0.agentId == id }) }
  }

  func refresh(waitForCurrent: Bool = false) async {
    guard !closed, !blocked, !Task.isCancelled else { return }
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
      }
      guard !Task.isCancelled, refreshGeneration == generation else { return }
      await restoreCached()
      guard !closed, !Task.isCancelled, refreshGeneration == generation else { return }
      isLoading = true
      repeat {
        refreshAgain = false
        do {
          let revision = readRevision
          let creation = creationRevision
          let response = try await ChatReadRecovery.read("chat list", sleep: readRetrySleep) {
            try await sync.threadsWithIndicators()
          }
          var result = response.threads
          try Task.checkCancellation()
          guard !closed, refreshGeneration == generation else { return }
          optimisticChanges.removeAll { response.eventIDs.contains($0.id) }
          // A read started before creation cannot remove its acknowledged thread.
          guard creation == creationRevision else {
            refreshAgain = true
            continue
          }
          if revision != readRevision {
            for index in result.indices {
              let held = threads.first { $0.id == result[index].id }
              result[index].indicator = held?.indicator
              result[index].unreadAt = held?.unreadAt
            }
            refreshAgain = true
          } else {
            unreadAgentIDs = Set(
              response.indicators?.agents.filter { $0.value == .unread }.map(\.key) ?? [])
          }
          projectThreads(result)
          refreshError = nil
          indicatorsError = nil
        } catch is CancellationError {
          return
        } catch {
          guard !Task.isCancelled, refreshGeneration == generation else { return }
          showRefreshFailure(error)
        }
      } while refreshAgain && !closed && !blocked && !Task.isCancelled
    }
    refreshTask = task
    await task.value
  }

  func insertCreated(_ thread: ChatThread) {
    creationRevision += 1
    hasLoadedThreads = true
    // Realtime can publish a committed thread before its POST response arrives.
    if !threads.contains(where: { $0.id == thread.id }) { threads.insert(thread, at: 0) }
  }

  func markRead(_ id: String, through watermark: Date?) {
    guard !closed, let watermark else { return }
    readRevision += 1
    if let index = threads.firstIndex(where: { $0.id == id }),
      let unreadAt = threads[index].unreadAt, unreadAt <= watermark
    {
      threads[index].unreadAt = nil
      if threads[index].indicator == .unread { threads[index].indicator = nil }
    }
    didRefresh(threads)
  }

  func setRead(_ thread: ChatThread, read: Bool) async -> Bool {
    guard !updatingThreads.contains(thread.id), !closed, !blocked, !markingAgentRead,
      !Task.isCancelled
    else {
      return false
    }
    updatingThreads.insert(thread.id)
    readRevision += 1
    defer { updatingThreads.remove(thread.id) }
    var succeeded = false
    let task = Task { [weak self] in
      guard let self else { return }
      defer { updateTasks[thread.id] = nil }
      do {
        if read {
          let watermark = try await commands.markRead(threadID: thread.id)
          try Task.checkCancellation()
          markRead(thread.id, through: watermark)
        } else {
          try await commands.markUnread(threadID: thread.id)
        }
        try Task.checkCancellation()
        readRevision += 1
        actionError = nil
        succeeded = true
        await refreshIndicators()
      } catch is CancellationError {
      } catch { show(error) }
    }
    updateTasks[thread.id] = task
    await task.value
    return succeeded && !closed && !Task.isCancelled
  }

  func markAgentRead(_ agentID: String) async {
    guard !closed, !blocked, !markingAgentRead, updatingThreads.isEmpty, !Task.isCancelled else {
      return
    }
    markingAgentRead = true
    readRevision += 1
    defer { markingAgentRead = false }
    await updateThread("agent-read") { [self, commands] in
      try await commands.markAgentRead(agentID: agentID)
      readRevision += 1
    }
  }

  func threads(agentID: String?, archived: Bool) -> [ChatThread] {
    threads.filter {
      guard $0.agentID == agentID else { return false }
      if onlyUnread {
        // PWA's unread list includes archived chats and retains active-indicator precedence.
        return !$0.isMuted && $0.indicator == .unread
      }
      // Cached recent chats can render before switches arrive. Keep archived
      // chats in their own section until the server resolves that visibility.
      return archivingEnabled == false || $0.isArchived == archived
    }
  }

  func refreshIndicators() async {
    guard !closed, !blocked, !Task.isCancelled else { return }
    if let indicatorsTask {
      indicatorsAgain = true
      await indicatorsTask.value
      return
    }
    let generation = refreshGeneration
    let task = Task { [weak self] in
      guard let self else { return }
      defer {
        if refreshGeneration == generation { indicatorsTask = nil }
      }
      guard !Task.isCancelled, refreshGeneration == generation else { return }
      repeat {
        indicatorsAgain = false
        do {
          let revision = readRevision
          let result = try await ChatReadRecovery.read("chat indicators", sleep: readRetrySleep) {
            try await sync.indicators()
          }
          try Task.checkCancellation()
          guard !closed, refreshGeneration == generation else { return }
          guard revision == readRevision else {
            await refresh()
            return
          }
          unreadAgentIDs = Set(result.agents.filter { $0.value == .unread }.map(\.key))
          threads = threads.map { thread in
            var updated = thread
            updated.indicator = result.threads[thread.id]
            updated.unreadAt = result.unreadAt[thread.id]
            if thread.isMuted && updated.indicator == .unread { updated.indicator = nil }
            return updated
          }
          indicatorsError = nil
          didRefresh(threads)
        } catch is CancellationError {
          return
        } catch {
          guard !closed, !Task.isCancelled, refreshGeneration == generation else { return }
          indicatorsError = error.localizedDescription
          blocked = (error as? APIClientError)?.statusCode == 426
          didFail(error)
        }
      } while indicatorsAgain && !closed && !blocked && !Task.isCancelled
    }
    indicatorsTask = task
    await task.value
  }

  func togglePinned(_ id: String) async {
    guard let thread = threads.first(where: { $0.id == id }) else { return }
    await setPinned(thread, pinned: thread.pinnedAt == nil)
  }

  func canPin(_ id: String) -> Bool {
    !closed && !blocked && (!updatingThreads.contains(id) || lastPinIDs[id] != nil)
  }

  func setPinned(_ thread: ChatThread, pinned: Bool) async {
    guard canPin(thread.id), !Task.isCancelled,
      let current = threads.first(where: { $0.id == thread.id }),
      (current.pinnedAt != nil) != pinned
    else { return }
    // Match PostgreSQL's canonical UUID text in the persistent event stream.
    let eventID = UUID().uuidString.lowercased()
    let pinOrder: String?
    do {
      pinOrder =
        pinned
        ? try ChatThreadReplay.firstPinOrder(
          threads.filter { $0.agentID == current.agentID && $0.id != current.id }) : nil
    } catch {
      show(error)
      return
    }
    optimisticChanges.append(
      (
        eventID,
        ChatThreadChange(
          kind: pinned ? .pinned : .unpinned, chatThreadId: current.id,
          agentId: current.agentID, pinOrder: pinOrder, createdAt: .now)
      ))
    projectThreads(threads)
    let previous = lastPinIDs[current.id].flatMap { pinTasks[$0] }
    let task = Task { [weak self] in
      guard let self else { return }
      defer {
        pinTasks[eventID] = nil
        if lastPinIDs[current.id] == eventID {
          lastPinIDs[current.id] = nil
          updatingThreads.remove(current.id)
        }
      }
      await previous?.value
      guard !closed, !blocked, !Task.isCancelled else { return }
      do {
        try await commands.setPinned(
          threadID: current.id, pinned: pinned, eventID: eventID, pinOrder: pinOrder)
        try Task.checkCancellation()
        guard !closed else { return }
        await refresh()
      } catch is CancellationError {
      } catch { show(error) }
    }
    pinTasks[eventID] = task
    lastPinIDs[current.id] = eventID
    updatingThreads.insert(current.id)
    await task.value
  }

  private func projectThreads(_ snapshot: [ChatThread]) {
    let result = ChatThreadReplay.sidebarOrder(
      ChatThreadReplay.replay(snapshot: snapshot, events: optimisticChanges.map(\.change)))
    hasLoadedThreads = true
    if threads != result { threads = result }
    didRefresh(result)
  }

  func dismissError() {
    actionError = nil
  }

  func canUpdate(_ id: String) -> Bool {
    !closed && !blocked && !updatingThreads.contains(id) && !markingAgentRead
      && threads.contains(where: { $0.id == id })
  }

  func canMute(_ id: String) -> Bool {
    canUpdate(id) && (canMuteChats || threads.first(where: { $0.id == id })?.isMuted == true)
  }

  @discardableResult
  func setArchived(
    _ thread: ChatThread, archived: Bool, eventID: String = UUID().uuidString.lowercased(),
    didBegin: @MainActor () -> Void = {}
  ) async -> Bool {
    guard canArchiveChats, canUpdate(thread.id), !Task.isCancelled else { return false }
    if !optimisticChanges.contains(where: { $0.id == eventID }) {
      optimisticChanges.append(
        (
          eventID,
          ChatThreadChange(
            kind: archived ? .archived : .unarchived, chatThreadId: thread.id,
            agentId: thread.agentID, createdAt: .now)
        ))
    }
    projectThreads(threads)
    didBegin()
    return await updateThread(thread.id) { [commands] in
      try await commands.setArchived(threadID: thread.id, archived: archived, eventID: eventID)
    }
  }

  @discardableResult
  func setMuted(_ id: String, muted: Bool, markRead: Bool = true) async -> Bool {
    guard canMute(id), !Task.isCancelled else { return false }
    readRevision += 1
    return await updateThread(id) { [self, commands] in
      // Replies suppressed while muted must not reappear as unread. Keep the chat
      // muted if marking read fails; retry can safely repeat both operations.
      if !muted && markRead {
        let watermark = try await commands.markRead(threadID: id)
        try Task.checkCancellation()
        self.markRead(id, through: watermark)
      }
      try await commands.setMuted(
        threadID: id, muted: muted, eventID: UUID().uuidString.lowercased())
      readRevision += 1
    }
  }

  @discardableResult
  func rename(_ thread: ChatThread, title: String) async -> Bool {
    guard canUpdate(thread.id), !Task.isCancelled,
      let current = threads.first(where: { $0.id == thread.id })
    else { return false }
    let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
    let pending = optimisticChanges.last {
      $0.change.kind == .renamed && $0.change.chatThreadId == thread.id
    }
    // A title already shown optimistically still needs an explicit retry until confirmed.
    guard !trimmed.isEmpty,
      trimmed != current.title.trimmingCharacters(in: .whitespacesAndNewlines)
        || pending?.change.title == trimmed
    else { return true }
    let eventID: String
    if let pending, pending.change.title == trimmed {
      eventID = pending.id
    } else {
      eventID = UUID().uuidString.lowercased()
      optimisticChanges.append(
        (
          eventID,
          ChatThreadChange(
            kind: .renamed, chatThreadId: current.id, agentId: current.agentID,
            title: trimmed, createdAt: .now)
        ))
    }
    projectThreads(threads)
    return await updateThread(thread.id) { [commands] in
      try await commands.rename(threadID: thread.id, title: trimmed, eventID: eventID)
    }
  }

  func beginRename(_ id: String) {
    guard !isSavingRename, canUpdate(id), let thread = threads.first(where: { $0.id == id }) else {
      return
    }
    renameSessionID = UUID()
    renameTitle = thread.title
    renameRequest = RenameRequest(id: renameSessionID, threadID: id)
  }

  func cancelRename() {
    renameSessionID = UUID()
    renameRequest = nil
  }

  func saveRename() async {
    guard !isSavingRename, let request = renameRequest,
      let thread = threads.first(where: { $0.id == request.threadID })
    else { return }
    isSavingRename = true
    defer { isSavingRename = false }
    let title = renameTitle
    renameRequest = nil
    let succeeded = await rename(thread, title: title)
    guard !succeeded, !closed, !blocked, renameSessionID == request.id else { return }
    // A fast failure can be coalesced with dismissal into one UI update.
    // Give the recovered editor a new presentation identity even in that case.
    renameSessionID = UUID()
    renameTitle = title
    renameRequest = RenameRequest(
      id: renameSessionID, threadID: request.threadID,
      error: error ?? "The title was not saved. Try again.")
    actionError = nil
  }

  @discardableResult
  private func updateThread(_ id: String, command: @escaping @MainActor () async throws -> Void)
    async -> Bool
  {
    guard !updatingThreads.contains(id), !closed, !blocked, !Task.isCancelled else { return false }
    updatingThreads.insert(id)
    var succeeded = false
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
        actionError = nil
        await refresh(waitForCurrent: true)
        succeeded = error == nil
      } catch is CancellationError {
      } catch { show(error) }
    }
    updateTasks[id] = task
    await task.value
    return succeeded && !closed && !blocked
  }

  func close() {
    closed = true
    cancelRefresh()
    navigationTask?.cancel()
    for task in updateTasks.values { task.cancel() }
    for task in pinTasks.values { task.cancel() }
    cancelRename()
  }

  private func show(_ failure: Error) {
    guard !closed, !Task.isCancelled else { return }
    actionError = failure.localizedDescription
    blocked = (failure as? APIClientError)?.statusCode == 426
    didFail(failure)
  }

  func cancelRefresh() {
    refreshGeneration = UUID()
    refreshTask?.cancel()
    indicatorsTask?.cancel()
    refreshTask = nil
    indicatorsTask = nil
    refreshAgain = false
    indicatorsAgain = false
    isLoading = false
    refreshError = nil
    indicatorsError = nil
  }

  private func showRefreshFailure(_ failure: Error) {
    guard !closed else { return }
    refreshError = failure.localizedDescription
    blocked = (failure as? APIClientError)?.statusCode == 426
    didFail(failure)
  }
}
