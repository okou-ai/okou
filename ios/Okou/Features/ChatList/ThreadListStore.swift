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
  @ObservationIgnored private lazy var actions = ThreadListMutations(
    owner: self, client: client, commands: commands, lifecycleTasks: lifecycleTasks,
    readThreads: { [weak self] in self?.threads ?? [] },
    isClosed: { [weak self] in self?.closed != false },
    isBlocked: { [weak self] in self?.blocked != false },
    setBlocked: { [weak self] in self?.blocked = $0 },
    isMarkingRead: { [weak self] in self?.markingAgentRead != false },
    canMute: { [weak self] in self?.canMute($0) == true },
    didProject: { [weak self] in self?.publishThreads($0) },
    refreshList: { [weak self] wait, indicators in
      _ = await self?.refresh(waitForCurrent: wait, includingIndicators: indicators)
    },
    didMarkRead: { [weak self] in self?.markRead($0, through: $1) },
    advanceReadRevision: { [weak self] in self?.readRevision += 1 }, didFail: didFail)
  @ObservationIgnored private lazy var navigation = ThreadListNavigation(
    resources: resources, sync: sync, lifecycleTasks: lifecycleTasks,
    didLoadAgents: didLoadAgents, didFail: didFail,
    didBlock: { [weak self] in self?.blocked = true })
  @ObservationIgnored private let confirmedThreads = CCState.State<[ChatThread]>([])
  @ObservationIgnored private let replaceThreads: Command<Void, [ChatThread]>
  let threadsValue: Computed<[ChatThread]>
  var agentsValue: Computed<[AgentRecord]> { navigation.agentsValue }

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
  var agents: [AgentRecord] { navigation.agents }
  private(set) var unreadAgentIDs: Set<String> = []
  private(set) var markingAgentRead = false
  private var readRevision = 0
  var actionError: String? { actions.actionError }

  private var indicatorsError: String?
  // Standalone indicator failures retain their own policy; list errors live on listValue.
  var syncError: String? { indicatorsError }
  private(set) var hasLoadedThreads = false
  var updatingThreads: Set<String> { actions.updatingThreads }

  private let client: APIClient
  private let sync: ChatSync
  private let resources: WorkspaceResources
  private let commands: ChatCommands
  private let didRefresh: @MainActor ([ChatThread]) -> Void
  private let didChangeReadState: @MainActor () -> Void
  private let didLoadAgents: @MainActor ([AgentRecord]) -> Void
  private let didFail: @MainActor (Error) -> Void
  private let readRetrySleep: @Sendable (Duration) async throws -> Void
  private let indicatorsBootstrap: WorkspaceReadBootstrap?
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
  private var indicatorsTask: Task<Void, Never>?
  private var updateTasks: [String: Task<Void, Never>] = [:]
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
    didChangeReadState: @escaping @MainActor () -> Void = {},
    didLoadAgents: @escaping @MainActor ([AgentRecord]) -> Void = { _ in },
    readRetrySleep: @escaping @Sendable (Duration) async throws -> Void = {
      try await Task.sleep(for: $0)
    },
    indicatorsBootstrap: WorkspaceReadBootstrap? = nil,
    lifecycleTasks: LifecycleTasks? = nil
  ) {
    self.lifecycleTasks = lifecycleTasks ?? LifecycleTasks()
    let confirmedThreads = confirmedThreads
    threadsValue = Computed { try $0(confirmedThreads) }
    replaceThreads = Command { context, value in try context.set(confirmedThreads, value) }
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
    self.didChangeReadState = didChangeReadState
    self.didLoadAgents = didLoadAgents
    self.didFail = didFail
    self.readRetrySleep = readRetrySleep
    self.indicatorsBootstrap = indicatorsBootstrap
  }

  func restoreCached() async {
    guard !closed, !Task.isCancelled else { return }
    await navigation.restoreCached()
    guard !closed, !Task.isCancelled else { return }
    let revision = creationRevision
    let sequence = hasLoadedThreads ? appliedThreadSequence : nil
    var restoredThreads = false
    if let cached = await sync.cachedThreadList(newerThan: sequence), !closed, !Task.isCancelled,
      revision == creationRevision,
      !hasLoadedThreads || cached.cursor.seqID > appliedThreadSequence
    {
      let restored = ThreadListReadProjection.restoring(cached.threads, preserving: threads)
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
    threads = ThreadListReadProjection.readState(threads, unreadAt: cached.unreadAt)
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
            actions.settleOptimisticChanges(eventIDs: response.eventIDs)
            // A read started before creation cannot remove its acknowledged thread.
            guard creation == creationRevision else {
              refreshAgain = true
              continue
            }
            let previous = Dictionary(uniqueKeysWithValues: threads.map { ($0.id, $0) })
            for index in result.indices {
              let held = previous[result[index].id]
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

  func refreshNavigation() async { await navigation.refreshNavigation() }

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
    didChangeReadState()
  }

  func setRead(_ thread: ChatThread, read: Bool) async -> Bool {
    guard updateTasks[thread.id] == nil, !updatingThreads.contains(thread.id), !closed, !blocked,
      !markingAgentRead,
      !Task.isCancelled
    else {
      return false
    }
    actions.beginUpdating(thread.id)
    readRevision += 1
    defer { actions.finishUpdating(thread.id) }
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
          try Task.checkCancellation()
          didChangeReadState()
        }
        try Task.checkCancellation()
        readRevision += 1
        actions.dismissError()
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
    await actions.updateThread("agent-read", includingIndicators: true) { [self, commands] in
      try await commands.markAgentRead(agentID: agentID)
      try Task.checkCancellation()
      didChangeReadState()
      readRevision += 1
    }
  }

  func refreshIndicators(waitForSubscriptions: Bool = false) async {
    guard !closed, !blocked, !Task.isCancelled else { return }
    // Real invalidations must also release a startup read still waiting for attachment.
    if !waitForSubscriptions { indicatorsBootstrap?.allowHTTP() }
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
          try await indicatorsBootstrap?.wait()
          try Task.checkCancellation()
          indicatorsBootstrap?.didScheduleRead()
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
              .info(
                "event=chat.indicators.read.failed error_domain=\((error as NSError).domain, privacy: .public) error_code=\((error as NSError).code) error=\(error.localizedDescription, privacy: .private)"
              )
          }
        }
      } while indicatorsAgain && !closed && !blocked && !Task.isCancelled
    }
    lifecycleTasks.track(task)
    indicatorsTask = task
    await task.value
  }

  func canPin(_ id: String) -> Bool {
    actions.canPin(id)
  }

  func setPinned(_ thread: ChatThread, pinned: Bool) async {
    await actions.setPinned(thread, pinned: pinned)
  }

  /// Places a pinned chat beside another pin listed with it, as the PWA's Move up / Move down.
  /// A pin ranks against the pins listed with it: its project's chats, which can belong to
  /// several Agents, or else its Agent's chats. Only the moved rank (and a tied run) changes.
  func movePinned(
    _ id: String, beside targetID: String, placement: ChatThreadReplay.PinPlacement,
    projectID: String? = nil
  ) async {
    await actions.movePinned(id, beside: targetID, placement: placement, projectID: projectID)
  }

  private func projectThreads(_ snapshot: [ChatThread]) {
    publishThreads(actions.projected(snapshot))
  }

  private func publishThreads(_ result: [ChatThread]) {
    hasLoadedThreads = true
    if threads != result { threads = result }
    didRefresh(result)
  }

  @discardableResult
  func setProject(
    _ id: String, projectID: String?, onFailure: (@MainActor (String) -> Void)? = nil,
    didBegin: @MainActor () -> Void = {}
  ) async -> Bool {
    return await actions.setProject(
      id, projectID: projectID, onFailure: onFailure, didBegin: didBegin)
  }

  func dismissError() {
    actions.dismissError()
  }

  func canUpdate(_ id: String) -> Bool {
    actions.canUpdate(id)
  }

  @discardableResult
  func setArchived(
    _ thread: ChatThread, archived: Bool, eventID: String = UUID().uuidString.lowercased(),
    onFailure: (@MainActor (String) -> Void)? = nil,
    didBegin: @MainActor () -> Void = {}
  ) async -> Bool {
    return await actions.setArchived(
      thread, archived: archived, eventID: eventID, onFailure: onFailure, didBegin: didBegin)
  }

  @discardableResult
  func setMuted(
    _ id: String, muted: Bool, markRead: Bool = true,
    onFailure: (@MainActor (String) -> Void)? = nil
  ) async -> Bool {
    return await actions.setMuted(id, muted: muted, markRead: markRead, onFailure: onFailure)
  }

  @discardableResult
  func rename(_ thread: ChatThread, title: String) async -> Bool {
    return await actions.rename(thread, title: title)
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
    actions.dismissError()
  }

  func close() {
    closed = true
    activeThreadIDs.removeAll()
    cancelRefresh()
    do { try stateStore.set(listLifetime, false) } catch { didFail(error) }
    navigation.close()
    for task in updateTasks.values { task.cancel() }
    actions.close()
    cancelRename()
  }

  /// Startup retirement detaches confirmation without cancelling another consumer's I/O.
  func cancelNavigationPublication() { navigation.cancelNavigationPublication() }

  private func show(_ failure: Error) {
    actions.show(failure)
  }

  /// Return unfinished list demand so a suspended workspace can resume it explicitly.
  @discardableResult
  func cancelRefresh() -> Bool {
    let interruptedList = listTask != nil
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
    return interruptedList
  }

  isolated deinit { listTask?.cancel() }
}

extension ThreadListStore {
  func canWrite(_ id: String) -> Bool {
    actions.canWrite(id)
  }

  @discardableResult
  func delete(
    _ id: String, agentID: String?, eventID: String,
    onFailure: (@MainActor (String) -> Void)? = nil
  ) async -> Bool {
    return await actions.delete(id, agentID: agentID, eventID: eventID, onFailure: onFailure)
  }
}
