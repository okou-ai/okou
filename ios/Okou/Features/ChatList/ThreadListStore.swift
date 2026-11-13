import CCState
import ChatData
import ChatDomain
import Foundation
import OSLog
import Observation

/// Navigation data and list presentation for one workspace.
@MainActor @Observable
final class ThreadListStore {
  private let lifecycleTasks: LifecycleTasks
  @ObservationIgnored private let confirmedThreads = CCState.State<[ChatThread]>([])
  @ObservationIgnored private let confirmedAgents = CCState.State<[AgentRecord]>([])
  @ObservationIgnored private let replaceThreads: Command<Void, [ChatThread]>
  @ObservationIgnored private let replaceAgents: Command<Void, [AgentRecord]>
  let threadsValue: Computed<[ChatThread]>
  let agentsValue: Computed<[AgentRecord]>

  private(set) var threads: [ChatThread] {
    get {
      access(keyPath: \.threads)
      return confirmed(threadsValue)
    }
    set {
      guard newValue != confirmed(threadsValue) else { return }
      withMutation(keyPath: \.threads) {
        do { try stateStore.set(replaceThreads, newValue) } catch {
          preconditionFailure("Cannot publish confirmed threads: \(error)")
        }
      }
    }
  }
  /// Confirmed navigation drives default-Agent decisions and the durable ChatSync baseline.
  /// Current read loading/errors belong exclusively to navigationValue.
  private(set) var agents: [AgentRecord] {
    get {
      access(keyPath: \.agents)
      return confirmed(agentsValue)
    }
    set {
      guard newValue != confirmed(agentsValue) else { return }
      withMutation(keyPath: \.agents) {
        do { try stateStore.set(replaceAgents, newValue) } catch {
          preconditionFailure("Cannot publish confirmed Agents: \(error)")
        }
      }
    }
  }
  private(set) var unreadAgentIDs: Set<String> = []
  var hasUnreadThreads: Bool {
    threads.contains { !$0.isMuted && $0.indicator == .unread }
  }
  private(set) var markingAgentRead = false
  private var readRevision = 0
  private(set) var actionError: String?
  private var indicatorsError: String?
  // Standalone indicator failures retain their own policy; list errors live on listValue.
  var syncError: String? { indicatorsError }
  var error: String? { actionError ?? syncError }
  private(set) var hasLoadedThreads = false
  private(set) var updatingThreads: Set<String> = []
  private let client: APIClient
  private let sync: ChatSync
  private let resources: WorkspaceResources
  private let commands: ChatCommands
  private let didRefresh: @MainActor ([ChatThread]) -> Void
  private let didLoadAgents: @MainActor ([AgentRecord]) -> Void
  private let didFail: @MainActor (Error) -> Void
  private let readRetrySleep: @Sendable (Duration) async throws -> Void
  private var refreshAgain = false
  private var indicatorsAgain = false
  private var refreshGeneration = UUID()
  private var appliedThreadSequence = 0
  private var appliedIndicatorsRevision = 0
  // Online running state can arrive before its list event. Keep the current
  // server set so later metadata can project it; running state is never persisted.
  private var activeThreadIDs: Set<String> = []
  private var creationRevision = 0
  @ObservationIgnored private let listDemand = CCState.State<UUID?>(nil)
  @ObservationIgnored private let listLifetime = CCState.State(true)
  @ObservationIgnored private let reloadList: Command<Void, Void>
  @ObservationIgnored private let clearList: Command<Void, Void>
  // Original request ownership and coalescing, not a second read phase/result.
  private var listTask: Task<Void, Error>?
  private var listReadID: UUID?
  @ObservationIgnored private var navigationSubscription: Subscription?
  @ObservationIgnored private var navigationPublication: Task<Void, Never>?
  private var navigationReadID = UUID()
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
    client: APIClient, sync: ChatSync, commands: ChatCommands, resources: WorkspaceResources,
    didRefresh: @escaping @MainActor ([ChatThread]) -> Void,
    didFail: @escaping @MainActor (Error) -> Void,
    didLoadAgents: @escaping @MainActor ([AgentRecord]) -> Void = { _ in },
    readRetrySleep: @escaping @Sendable (Duration) async throws -> Void = {
      try await Task.sleep(for: $0)
    },
    lifecycleTasks: LifecycleTasks? = nil
  ) {
    self.lifecycleTasks = lifecycleTasks ?? LifecycleTasks()
    let confirmedThreads = confirmedThreads
    let confirmedAgents = confirmedAgents
    threadsValue = Computed { try $0(confirmedThreads) }
    agentsValue = Computed { try $0(confirmedAgents) }
    replaceThreads = Command { context, value in try context.set(confirmedThreads, value) }
    replaceAgents = Command { context, value in try context.set(confirmedAgents, value) }
    let listDemand = listDemand
    let listLifetime = listLifetime
    reloadList = Command { context in
      guard try context.get(listLifetime) else { throw CancellationError() }
      try context.set(listDemand, UUID())
    }
    clearList = Command { context in try context.set(listDemand, nil) }
    self.client = client
    self.sync = sync
    self.resources = resources
    self.commands = commands
    self.didRefresh = didRefresh
    self.didLoadAgents = didLoadAgents
    self.didFail = didFail
    self.readRetrySleep = readRetrySleep
  }

  func restoreCached() async {
    guard !closed, !Task.isCancelled else { return }
    if !restoredNavigation, navigationRevision == 0 {
      let revision = navigationRevision
      let cached = await sync.cachedNavigation()
      guard !closed, !Task.isCancelled else { return }
      if let cached, !restoredNavigation, navigationRevision == revision {
        agents = cached.agents
        didLoadAgents(agents)
      }
      restoredNavigation = true
    }
    let revision = creationRevision
    let sequence = hasLoadedThreads ? appliedThreadSequence : nil
    var restoredThreads = false
    if let cached = await sync.cachedThreadList(newerThan: sequence), !closed, !Task.isCancelled,
      revision == creationRevision,
      !hasLoadedThreads || cached.cursor.seqID > appliedThreadSequence
    {
      let previous = Dictionary(uniqueKeysWithValues: threads.map { ($0.id, $0) })
      let restored = cached.threads.map { thread in
        var updated = thread
        updated.indicator = previous[thread.id]?.indicator
        updated.unreadAt = previous[thread.id]?.unreadAt
        return updated
      }
      appliedThreadSequence = cached.cursor.seqID
      projectThreads(restored)
      restoredThreads = true
    }
    // Read changes need not advance the thread-list event cursor. Re-read the
    // independent snapshot even in an already-mounted, unchanged list.
    let read = readRevision
    guard let cached = await sync.cachedIndicators(), !closed, !Task.isCancelled,
      read == readRevision, restoredThreads || cached.revision > appliedIndicatorsRevision
    else { return }
    appliedIndicatorsRevision = cached.revision
    unreadAgentIDs = cached.unreadAgentIDs
    threads = threads.map { thread in
      var updated = thread
      updated.unreadAt = thread.isMuted ? nil : cached.unreadAt[thread.id]
      if updated.unreadAt != nil {
        updated.indicator = .unread
      } else if updated.indicator == .unread {
        updated.indicator = nil
      }
      return updated
    }
    if hasLoadedThreads { didRefresh(threads) }
  }

  var stateStore: CCState.Store { resources.store }
  var navigationValue: Computed<Task<[AgentRecord], Error>> { resources.navigation }
  @ObservationIgnored lazy var listValue = makeListValue()

  private func makeListValue() -> Computed<Task<Void, Error>> {
    Computed { [weak self] get, options in
      guard let self, try get(listLifetime), !closed else { throw CancellationError() }
      guard let demand = try get(listDemand) else { return Task<Void, Error>.immediate {} }
      let signal = options.signal
      let task = Task<Void, Error> { @MainActor [weak self] in
        guard let self else { throw CancellationError() }
        defer {
          if listReadID == demand {
            listTask = nil
            listReadID = nil
          }
        }
        try Task.checkCancellation()
        try signal.checkCancellation()
        await restoreCached()
        try Task.checkCancellation()
        try signal.checkCancellation()
        guard !closed else { throw CancellationError() }
        repeat {
          refreshAgain = false
          do {
            let revision = readRevision
            let creation = creationRevision
            let response = try await ChatReadRecovery.read("chat list", sleep: readRetrySleep) {
              try await self.sync.threadList()
            }
            var result = response.threads
            let cachedUnread = await sync.cachedIndicators()
            try Task.checkCancellation()
            try signal.checkCancellation()
            guard !closed else { throw CancellationError() }
            settleOptimisticChanges(eventIDs: response.eventIDs)
            // A read started before creation cannot remove its acknowledged thread.
            guard creation == creationRevision else {
              refreshAgain = true
              continue
            }
            for index in result.indices {
              let held = threads.first { $0.id == result[index].id }
              let unreadAt =
                revision == readRevision && cachedUnread != nil
                ? cachedUnread?.unreadAt[result[index].id] : held?.unreadAt
              result[index].unreadAt = unreadAt
              if activeThreadIDs.contains(result[index].id) {
                result[index].indicator = .active
              } else if !result[index].isMuted && unreadAt != nil {
                result[index].indicator = .unread
              } else {
                result[index].indicator = nil
              }
            }
            if revision == readRevision, let cachedUnread,
              cachedUnread.revision > appliedIndicatorsRevision
            {
              appliedIndicatorsRevision = cachedUnread.revision
              unreadAgentIDs = cachedUnread.unreadAgentIDs
            }
            guard response.cursor.seqID >= appliedThreadSequence else { continue }
            appliedThreadSequence = response.cursor.seqID
            projectThreads(result)
          } catch {
            try Task.checkCancellation()
            try signal.checkCancellation()
            guard !closed else { throw CancellationError() }
            blocked = (error as? APIClientError)?.statusCode == 426
            didFail(error)
            if refreshAgain && !blocked { continue }
            throw error
          }
        } while refreshAgain && !closed && !blocked && !Task.isCancelled
        try Task.checkCancellation()
        try signal.checkCancellation()
      }
      listTask = task
      listReadID = demand
      lifecycleTasks.track(task)
      signal.onCancel { task.cancel() }
      return task
    }
  }

  private func confirmed<Value>(_ signal: Signal<Value>) -> Value {
    // These are synchronous local business values, not a network or persistence boundary.
    do { return try stateStore.get(signal) } catch {
      preconditionFailure("Cannot read confirmed navigation: \(error)")
    }
  }

  func refreshNavigation() async {
    guard !closed, !blocked, !Task.isCancelled else { return }
    await restoreCached()
    guard !closed, !blocked, !Task.isCancelled else { return }
    do {
      if navigationSubscription == nil {
        navigationSubscription = try stateStore.watch(navigationValue) { [weak self] in
          self?.confirmNavigation()
        }
        // watch establishes dependencies but does not initially invoke its listener.
        confirmNavigation()
      } else if navigationPublication == nil {
        try stateStore.set(resources.reloadNavigation)
      }
      // This waiter owns neither the shared I/O nor confirmed-snapshot publication.
      await navigationPublication?.value
    } catch is CancellationError {
    } catch { didFail(error) }
  }

  /// A workspace-owned subscriber reconciles successful reads to business/persistence state.
  /// SwiftUI observes navigationValue itself; this waiter never mirrors its loadable phase.
  private func confirmNavigation() {
    guard !closed, !blocked else { return }
    navigationPublication?.cancel()
    let id = UUID()
    navigationReadID = id
    do {
      let read = try stateStore.get(navigationValue)
      navigationPublication = Task { [weak self] in
        guard let self else { return }
        defer {
          if navigationReadID == id { navigationPublication = nil }
        }
        do {
          let value = try await read.value
          try Task.checkCancellation()
          guard !closed, !blocked, navigationReadID == id else { return }
          navigationRevision += 1
          agents = value
          didLoadAgents(value)
          await sync.persistNavigation(SidebarNavigationSnapshot(agents: value))
        } catch is CancellationError {
        } catch {
          guard !closed, !Task.isCancelled, navigationReadID == id else { return }
          blocked = (error as? APIClientError)?.statusCode == 426
          didFail(error)
        }
      }
      if let navigationPublication { lifecycleTasks.track(navigationPublication) }
    } catch is CancellationError {
      navigationPublication = nil
    } catch { didFail(error) }
  }

  /// Explicit invalidations coalesce into the resident read and one follow-up cycle.
  /// Only an awaited successful cycle can authorize navigation that needed fresh chats.
  @discardableResult
  func refresh(waitForCurrent: Bool = false, includingIndicators: Bool = true) async -> Bool {
    async let indicators: Void = includingIndicators ? refreshIndicators() : ()
    let refreshed = await refreshList(waitForCurrent: waitForCurrent)
    await indicators
    return refreshed && indicatorsError == nil && !closed && !blocked
  }

  private func refreshList(waitForCurrent: Bool) async -> Bool {
    guard !closed, !blocked, !Task.isCancelled else { return false }
    if let listTask {
      refreshAgain = true
      guard waitForCurrent else { return false }
      do {
        try await listTask.value
        return !closed && !blocked && !Task.isCancelled
      } catch { return false }
    }
    do {
      try stateStore.set(reloadList)
      let read = try stateStore.get(listValue)
      try await read.value
      return !closed && !blocked && !Task.isCancelled
    } catch is CancellationError {
      return false
    } catch {
      // The original Task reports HTTP failures; do not mirror them in action state.
      return false
    }
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
    guard updateTasks[thread.id] == nil, !updatingThreads.contains(thread.id), !closed, !blocked,
      !markingAgentRead,
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
    lifecycleTasks.track(task)
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
    await updateThread("agent-read", includingIndicators: true) { [self, commands] in
      try await commands.markAgentRead(agentID: agentID)
      readRevision += 1
    }
  }

  func threads(agentID: String?, archived: Bool, onlyUnread: Bool = false) -> [ChatThread] {
    threads.filter {
      guard $0.agentID == agentID else { return false }
      if onlyUnread {
        // PWA's unread list includes archived chats and retains active-indicator precedence.
        return !$0.isMuted && $0.indicator == .unread
      }
      return $0.isArchived == archived
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
      await restoreCached()
      guard !closed, !Task.isCancelled, refreshGeneration == generation else { return }
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
            indicatorsAgain = true
            continue
          }
          activeThreadIDs = Set(result.threads.filter { $0.value == .active }.map(\.key))
          unreadAgentIDs = Set(result.agents.filter { $0.value == .unread }.map(\.key))
          threads = threads.map { thread in
            var updated = thread
            updated.indicator = result.threads[thread.id]
            updated.unreadAt = result.unreadAt[thread.id]
            if thread.isMuted && updated.indicator == .unread { updated.indicator = nil }
            return updated
          }
          indicatorsError = nil
          // Indicators cannot establish list membership before metadata arrives.
          if hasLoadedThreads { didRefresh(threads) }
        } catch is CancellationError {
          return
        } catch {
          guard !closed, !Task.isCancelled, refreshGeneration == generation else { return }
          if let api = error as? APIClientError, api.statusCode == 401 || api.statusCode == 426 {
            indicatorsError = error.localizedDescription
            blocked = api.statusCode == 426
            didFail(error)
          } else {
            // Unread refresh is best-effort: retain the confirmed presentation
            // without adding a user-facing synchronization warning.
            Logger(subsystem: "ai.okou.ios", category: "ChatSync")
              .info("Keeping unread indicators: \(error.localizedDescription, privacy: .public)")
          }
        }
      } while indicatorsAgain && !closed && !blocked && !Task.isCancelled
    }
    lifecycleTasks.track(task)
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
        await refresh(includingIndicators: false)
      } catch is CancellationError {
      } catch { show(error) }
    }
    lifecycleTasks.track(task)
    pinTasks[eventID] = task
    lastPinIDs[current.id] = eventID
    updatingThreads.insert(current.id)
    await task.value
  }

  /// Places a pinned chat beside another pin listed with it, as the PWA's Move up / Move down.
  /// A pin ranks against the pins listed with it: its project's chats, which can belong to
  /// several Agents, or else its Agent's chats. Only the moved rank (and a tied run) changes.
  func movePinned(
    _ id: String, beside targetID: String, placement: ChatThreadReplay.PinPlacement,
    projectID: String? = nil
  ) async {
    guard canUpdate(id), !Task.isCancelled,
      let current = threads.first(where: { $0.id == id }), current.pinnedAt != nil
    else { return }
    let ranked = threads.filter { thread in
      if let projectID { return thread.projectId == projectID }
      return thread.agentID == current.agentID
    }
    let updates: [ChatThreadReplay.PinOrderUpdate]
    do {
      updates = try ChatThreadReplay.movePinOrder(
        ranked, threadID: id, targetID: targetID, placement: placement)
    } catch {
      show(error)
      return
    }
    guard !updates.isEmpty else { return }
    let agents = Dictionary(uniqueKeysWithValues: ranked.map { ($0.id, $0.agentID) })
    // Match PostgreSQL's canonical UUID text in the persistent event stream.
    let writes = updates.map { (eventID: UUID().uuidString.lowercased(), update: $0) }
    for write in writes {
      optimisticChanges.append(
        (
          write.eventID,
          // A re-ranked tie keeps its own Agent.
          ChatThreadChange(
            kind: .sortTouched, chatThreadId: write.update.threadID,
            agentId: agents[write.update.threadID] ?? current.agentID,
            pinOrder: write.update.pinOrder, createdAt: .now)
        ))
    }
    projectThreads(threads)
    await updateThread(id) { [commands] in
      for write in writes {
        try await commands.setPinOrder(
          threadID: write.update.threadID, pinOrder: write.update.pinOrder,
          eventID: write.eventID)
      }
    }
  }

  private func projectThreads(_ snapshot: [ChatThread]) {
    let result = ChatThreadReplay.sidebarOrder(
      ChatThreadReplay.replay(snapshot: snapshot, events: optimisticChanges.map(\.change)))
    hasLoadedThreads = true
    if threads != result { threads = result }
    didRefresh(result)
  }

  private func settleOptimisticChanges(eventIDs: Set<String>) {
    var confirmedMemberships: [String: Int] = [:]
    for (index, event) in optimisticChanges.enumerated()
    where event.change.kind == .projectUpdated && eventIDs.contains(event.id) {
      confirmedMemberships[event.change.chatThreadId] = index
    }
    optimisticChanges = optimisticChanges.enumerated().filter { index, event in
      !eventIDs.contains(event.id)
        && (event.change.kind != .projectUpdated
          || index > (confirmedMemberships[event.change.chatThreadId] ?? -1))
    }.map(\.element)
  }

  @discardableResult
  func setProject(
    _ id: String, projectID: String?, onFailure: (@MainActor (String) -> Void)? = nil,
    didBegin: @MainActor () -> Void = {}
  ) async -> Bool {
    guard canUpdate(id), !Task.isCancelled,
      let current = threads.first(where: { $0.id == id })
    else { return false }
    let pending = optimisticChanges.last {
      $0.change.kind == .projectUpdated && $0.change.chatThreadId == id
    }
    let retry = pending.map { $0.change.projectId == projectID } ?? false
    guard current.projectId != projectID || retry else { return false }
    let eventID: String
    if let pending, pending.change.projectId == projectID {
      eventID = pending.id
    } else {
      eventID = ChatProjects.operationID()
      optimisticChanges.append(
        (
          eventID,
          ChatThreadChange(
            kind: .projectUpdated, chatThreadId: id, agentId: current.agentID,
            projectId: projectID, createdAt: current.updatedAt)
        ))
    }
    projectThreads(threads)
    return await updateThread(id, onFailure: onFailure, didBegin: didBegin) { [client] in
      try await ChatProjects(client: client).move(
        threadID: id, projectID: projectID, eventID: eventID)
    }
  }

  func dismissError() {
    actionError = nil
  }

  func canUpdate(_ id: String) -> Bool {
    !closed && !blocked && !updatingThreads.contains(id) && !markingAgentRead
      && threads.contains(where: { $0.id == id })
  }

  func canMute(_ id: String) -> Bool {
    canUpdate(id)
  }

  @discardableResult
  func setArchived(
    _ thread: ChatThread, archived: Bool, eventID: String = UUID().uuidString.lowercased(),
    onFailure: (@MainActor (String) -> Void)? = nil,
    didBegin: @MainActor () -> Void = {}
  ) async -> Bool {
    guard canUpdate(thread.id), !Task.isCancelled else { return false }
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
    return await updateThread(thread.id, onFailure: onFailure) { [commands] in
      try await commands.setArchived(threadID: thread.id, archived: archived, eventID: eventID)
    }
  }

  @discardableResult
  func setMuted(
    _ id: String, muted: Bool, markRead: Bool = true,
    onFailure: (@MainActor (String) -> Void)? = nil
  ) async -> Bool {
    guard canMute(id), !Task.isCancelled else { return false }
    readRevision += 1
    return await updateThread(id, includingIndicators: true, onFailure: onFailure) {
      [self, commands] in
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
  private func updateThread(
    _ id: String, includingIndicators: Bool = false,
    onFailure: (@MainActor (String) -> Void)? = nil,
    didBegin: @MainActor () -> Void = {},
    command: @escaping @MainActor () async throws -> Void
  ) async -> Bool {
    guard updateTasks[id] == nil, !updatingThreads.contains(id), !closed, !blocked,
      !Task.isCancelled
    else { return false }
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
        succeeded = true
        await refresh(waitForCurrent: true, includingIndicators: includingIndicators)
      } catch is CancellationError {
      } catch {
        guard !closed, !Task.isCancelled else { return }
        if let onFailure {
          blocked = (error as? APIClientError)?.statusCode == 426
          didFail(error)
          onFailure(error.localizedDescription)
        } else {
          show(error)
        }
      }
    }
    lifecycleTasks.track(task)
    updateTasks[id] = task
    didBegin()
    await task.value
    return succeeded && !closed && !blocked
  }

  func close() {
    closed = true
    activeThreadIDs.removeAll()
    cancelRefresh()
    do { try stateStore.set(listLifetime, false) } catch { didFail(error) }
    cancelNavigationPublication()
    for task in updateTasks.values { task.cancel() }
    for task in pinTasks.values { task.cancel() }
    cancelRename()
  }

  /// Startup retirement detaches confirmation without cancelling another consumer's I/O.
  func cancelNavigationPublication() {
    navigationReadID = UUID()
    navigationPublication?.cancel()
    navigationPublication = nil
    do { try navigationSubscription?.cancel() } catch { didFail(error) }
    navigationSubscription = nil
  }

  private func show(_ failure: Error) {
    guard !closed, !Task.isCancelled else { return }
    actionError = failure.localizedDescription
    blocked = (failure as? APIClientError)?.statusCode == 426
    didFail(failure)
  }

  func cancelRefresh() {
    refreshGeneration = UUID()
    listTask?.cancel()
    indicatorsTask?.cancel()
    listTask = nil
    listReadID = nil
    do { try stateStore.set(clearList) } catch { didFail(error) }
    indicatorsTask = nil
    refreshAgain = false
    indicatorsAgain = false
    indicatorsError = nil
  }

  isolated deinit { listTask?.cancel() }
}
