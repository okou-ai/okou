import CCState
import ChatData
import ChatDomain
import Foundation
import OSLog

/// Navigation data and list presentation for one workspace.
@MainActor
final class ThreadListStore {
  private let lifecycleTasks: LifecycleTasks
  private lazy var actions = ThreadListMutations(
    owner: self, client: client, commands: commands, lifecycleTasks: lifecycleTasks,
    readThreads: { [weak self] in self?.threads ?? [] },
    isClosed: { [weak self] in self?.closed != false },
    isBlocked: { [weak self] in self?.blocked != false },
    setBlocked: { [weak self] in self?.blocked = $0 },
    isMarkingRead: { [weak self] in self?.markingAllRead != false },
    canMute: { [weak self] in self?.canMute($0) == true },
    didProject: { [weak self] in self?.publishThreads($0) },
    refreshList: { [weak self] wait, indicators in
      _ = await self?.refresh(waitForCurrent: wait, includingIndicators: indicators)
    },
    didMarkRead: { [weak self] in self?.markRead($0, through: $1) },
    advanceReadRevision: { [weak self] in self?.readRevision += 1 }, didFail: didFail)
  private let confirmedThreads = CCState.State<[ChatThread]>([])
  private let replaceThreads: Command<Void, [ChatThread]>
  /// The confirmed chats, kept in the workspace session's Store. Views read it through
  /// CCStateSwiftUI; `threads` serves owner logic, actions and tests.
  let threadsValue: Computed<[ChatThread]>
  private let confirmedUnread = CCState.State<Set<String>>([])
  private let replaceUnread: Command<Void, Set<String>>
  /// Chats the read-state snapshot marks unread, kept in the workspace session's Store. Views
  /// read it through CCStateSwiftUI; `unreadThreadIDs` serves owner logic, actions and tests.
  let unreadThreadIDsValue: Computed<Set<String>>
  /// Mark-all-read, the indicators read's failure and the rename editor, kept in the workspace
  /// session's Store. Views resolve `statusValue`; the accessors serve owner logic and tests.
  struct Status: Equatable {
    var markingAllRead = false
    // Standalone indicator failures retain their own policy; list errors live on listValue.
    var syncError: String?
    var renameRequest: RenameRequest?
    var isSavingRename = false
    var renameTitle = ""
  }
  let statusValue: Computed<Status>
  private let statusState = CCState.State(Status())
  private var readRevision = 0
  var actionError: String? { actions.actionError }

  private let loadedThreads = CCState.State(false)
  private let replaceLoadedThreads: Command<Void, Bool>
  /// Whether a chat list has been published, kept in the workspace session's Store. Views read
  /// it through CCStateSwiftUI; `hasLoadedThreads` serves owner logic and tests.
  let hasLoadedThreadsValue: Computed<Bool>
  var updatingThreads: Set<String> { actions.updatingThreads }

  private let client: APIClient
  private let sync: ChatSync
  private let resources: WorkspaceResources
  private let commands: ChatCommands
  private let didRefresh: @MainActor ([ChatThread]) -> Void
  private let didChangeReadState: @MainActor () -> Void
  private let didFail: @MainActor (Error) -> Void
  private let readRetrySleep: @Sendable (Duration) async throws -> Void
  private let indicatorsBootstrap: WorkspaceReadBootstrap?
  private var refreshAgain = false
  private var indicatorsAgain = false
  private var refreshGeneration = UUID()
  private var appliedCursor: ChatCacheCursor?
  private var appliedCursorIsDurable = false
  private var removedByCachedSnapshot = Set<String>()
  // A failed local cleanup stays hidden and is retried when the confirmed deletion is replayed.
  private var cleanedUnavailableThreads: [String: Bool] = [:]
  private let didDelete: @MainActor (String) -> Bool
  private let confirmAbsences: @MainActor (Set<String>) async -> Set<String>
  private var appliedIndicatorsRevision = 0
  // Online running state can arrive before its list event. Keep the current
  // server set so later metadata can project it; running state is never persisted.
  private(set) var activeThreadIDs: Set<String> = []
  private var creationRevision = 0
  private let listDemand = CCState.State<UUID?>(nil)
  private let listLifetime = CCState.State(true)
  private let reloadList: Command<Void, Void>
  private let clearList: Command<Void, Void>
  // Original request ownership and coalescing, not a second read phase/result.
  private var listTask: Task<Void, Error>?
  private var listReadID: UUID?
  private var indicatorsTask: Task<Void, Never>?
  private var updateTasks: [String: Task<Void, Never>] = [:]
  private var renameSessionID = UUID()
  private var closed = false
  private var blocked = false

  init(
    client: APIClient, sync: ChatSync, commands: ChatCommands, resources: WorkspaceResources,
    didRefresh: @escaping @MainActor ([ChatThread]) -> Void,
    didFail: @escaping @MainActor (Error) -> Void,
    didDelete: @escaping @MainActor (String) -> Bool = { _ in true },
    confirmAbsences: @escaping @MainActor (Set<String>) async -> Set<String> = { _ in [] },
    didChangeReadState: @escaping @MainActor () -> Void = {},
    readRetrySleep: @escaping @Sendable (Duration) async throws -> Void = {
      try await Task.sleep(for: $0)
    },
    indicatorsBootstrap: WorkspaceReadBootstrap? = nil,
    lifecycleTasks: LifecycleTasks? = nil
  ) {
    self.lifecycleTasks = lifecycleTasks ?? LifecycleTasks()
    let statusState = statusState
    statusValue = Computed { try $0(statusState) }
    let confirmedThreads = confirmedThreads
    threadsValue = Computed { try $0(confirmedThreads) }
    replaceThreads = Command { context, value in try context.set(confirmedThreads, value) }
    let confirmedUnread = confirmedUnread
    unreadThreadIDsValue = Computed { try $0(confirmedUnread) }
    replaceUnread = Command { context, value in try context.set(confirmedUnread, value) }
    let loadedThreads = loadedThreads
    hasLoadedThreadsValue = Computed { try $0(loadedThreads) }
    replaceLoadedThreads = Command { context, value in try context.set(loadedThreads, value) }
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
    self.didDelete = didDelete
    self.confirmAbsences = confirmAbsences
    self.didChangeReadState = didChangeReadState
    self.didFail = didFail
    self.readRetrySleep = readRetrySleep
    self.indicatorsBootstrap = indicatorsBootstrap
  }

  func restoreCached() async {
    guard !closed, !Task.isCancelled else { return }
    let revision = creationRevision
    let cursor = appliedCursor
    var restoredThreads = false
    let lowerBound = appliedCursorIsDurable ? nil : cursor?.seqID
    if let cached = await sync.cachedThreadList(newerThan: lowerBound, excluding: cursor), !closed,
      !Task.isCancelled,
      revision == creationRevision, appliedCursor == cursor
    {
      let restored = ThreadListReadProjection.restoring(cached.threads, preserving: threads)
      removedByCachedSnapshot.formUnion(
        Set(threads.map(\.id)).subtracting(cached.threads.map(\.id)))
      await applyList(cached, threads: restored)
      restoredThreads = true
    }
    // Read changes need not advance the thread-list event cursor. Re-read the
    // independent snapshot even in an already-mounted, unchanged list.
    let read = readRevision
    guard let cached = await sync.cachedIndicators(), !closed, !Task.isCancelled,
      read == readRevision, restoredThreads || cached.revision > appliedIndicatorsRevision
    else { return }
    appliedIndicatorsRevision = cached.revision
    unreadThreadIDs = Set(cached.unreadAt.keys)
    threads = ThreadListReadProjection.readState(threads, unreadAt: cached.unreadAt)
    if hasLoadedThreads { didRefresh(threads) }
  }

  var stateStore: CCState.Store { resources.store }
  lazy var listValue = makeListValue()

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
            let cursor = appliedCursor
            let response = try await ChatReadRecovery.read("chat list", sleep: readRetrySleep) {
              try await self.sync.threadList()
            }
            var result = response.threads
            // Compaction can remove a row without retaining its deletion event.
            let absent = response.removedThreadIDs.union(removedByCachedSnapshot).union(
              threads.map(\.id)
            )
            .subtracting(result.map(\.id)).subtracting(response.deletedThreadIDs)
            let confirmed = await confirmAbsences(absent)
            let cachedUnread = await sync.cachedIndicators()
            try Task.checkCancellation()
            try signal.checkCancellation()
            guard !closed else { throw CancellationError() }
            actions.settleOptimisticChanges(eventIDs: response.eventIDs)
            // Only the read that still owns this projection may replace it, including on rollback.
            guard creation == creationRevision, cursor == appliedCursor else {
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
              unreadThreadIDs = Set(cachedUnread.unreadAt.keys)
            }
            removedByCachedSnapshot.removeAll()
            await applyList(response, threads: result, confirming: confirmed)
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

  /// Explicit invalidations coalesce into the resident read and one follow-up cycle.
  /// Only an awaited successful cycle can authorize navigation that needed fresh chats.
  @discardableResult
  func refresh(waitForCurrent: Bool = false, includingIndicators: Bool = true) async -> Bool {
    async let indicators: Void = includingIndicators ? refreshIndicators() : ()
    let refreshed = await refreshList(waitForCurrent: waitForCurrent)
    await indicators
    return refreshed && syncError == nil && !closed && !blocked
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
      !markingAllRead,
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

  func markAllRead() async {
    guard !closed, !blocked, !markingAllRead, updatingThreads.isEmpty, !Task.isCancelled else {
      return
    }
    markingAllRead = true
    readRevision += 1
    defer { markingAllRead = false }
    await actions.updateThread("mark-all-read", includingIndicators: true) { [self, commands] in
      try await commands.markAllRead()
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
          unreadThreadIDs = Set(result.threads.compactMap { $0.value == .unread ? $0.key : nil })
          threads = threads.map { thread in
            var updated = thread
            updated.indicator = result.threads[thread.id]
            updated.unreadAt = result.unreadAt[thread.id]
            if thread.isMuted && updated.indicator == .unread { updated.indicator = nil }
            return updated
          }
          syncError = nil
          // Indicators cannot establish list membership before metadata arrives.
          if hasLoadedThreads { didRefresh(threads) }
        } catch is CancellationError {
          return
        } catch {
          guard !closed, !Task.isCancelled, refreshGeneration == generation else { return }
          if let api = error as? APIClientError, api.statusCode == 401 || api.statusCode == 426 {
            syncError = error.localizedDescription
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
  /// Only the moved rank and tied ranks change within the current list.
  func movePinned(
    _ id: String, beside targetID: String, placement: ChatThreadReplay.PinPlacement,
    projectID: String? = nil
  ) async {
    await actions.movePinned(id, beside: targetID, placement: placement, projectID: projectID)
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
    for task in updateTasks.values { task.cancel() }
    actions.close()
    cancelRename()
  }

  /// Startup retirement detaches confirmation without cancelling another consumer's I/O.

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
    syncError = nil
    return interruptedList
  }

  isolated deinit { listTask?.cancel() }
}

/// Synchronous accessors for the graph-backed list values, for owner logic, actions and tests.
extension ThreadListStore {
  private(set) var threads: [ChatThread] {
    get { confirmed(threadsValue) }
    set {
      guard newValue != confirmed(threadsValue) else { return }
      do { try stateStore.set(replaceThreads, newValue) } catch {
        preconditionFailure("Cannot publish confirmed threads: \(error)")
      }
    }
  }

  private(set) var unreadThreadIDs: Set<String> {
    get { confirmed(unreadThreadIDsValue) }
    set {
      guard newValue != confirmed(unreadThreadIDsValue) else { return }
      do { try stateStore.set(replaceUnread, newValue) } catch {
        preconditionFailure("Cannot publish unread chats: \(error)")
      }
    }
  }

  private(set) var hasLoadedThreads: Bool {
    get { confirmed(hasLoadedThreadsValue) }
    set {
      guard newValue != confirmed(hasLoadedThreadsValue) else { return }
      do { try stateStore.set(replaceLoadedThreads, newValue) } catch {
        preconditionFailure("Cannot publish the loaded chat list: \(error)")
      }
    }
  }

  /// The current value of `statusValue`.
  var status: Status { confirmed(statusValue) }
  private(set) var markingAllRead: Bool {
    get { status.markingAllRead }
    set { updateStatus { $0.markingAllRead = newValue } }
  }
  private(set) var syncError: String? {
    get { status.syncError }
    set { updateStatus { $0.syncError = newValue } }
  }
  private(set) var renameRequest: RenameRequest? {
    get { status.renameRequest }
    set { updateStatus { $0.renameRequest = newValue } }
  }
  private(set) var isSavingRename: Bool {
    get { status.isSavingRename }
    set { updateStatus { $0.isSavingRename = newValue } }
  }
  var renameTitle: String {
    get { status.renameTitle }
    set { updateStatus { $0.renameTitle = newValue } }
  }

  private func updateStatus(_ change: (inout Status) -> Void) {
    var next = status
    change(&next)
    guard next != status else { return }
    do { try stateStore.set(statusState, next) } catch {
      preconditionFailure("Cannot publish the chat list status: \(error)")
    }
  }

  private func confirmed<Value>(_ signal: Signal<Value>) -> Value {
    // These are synchronous local business values, not a network or persistence boundary.
    do { return try stateStore.get(signal) } catch {
      preconditionFailure("Cannot read confirmed navigation: \(error)")
    }
  }
}

extension ThreadListStore {
  private func projectThreads(_ snapshot: [ChatThread]) {
    publishThreads(actions.projected(snapshot))
  }

  private func publishThreads(_ result: [ChatThread]) {
    hasLoadedThreads = true
    threads = result.filter { cleanedUnavailableThreads[$0.id] == nil }
    didRefresh(threads)
  }

  private func applyList(
    _ response: ChatSync.ThreadList, threads: [ChatThread],
    confirming additionalDeletes: Set<String> = []
  ) async {
    appliedCursor = response.cursor
    appliedCursorIsDurable = response.isPersisted
    for id in response.deletedThreadIDs.union(additionalDeletes) { retireThread(id) }
    projectThreads(threads)
    await acknowledgeCleanup(response, confirming: additionalDeletes)
  }

  @discardableResult
  private func retireThread(_ id: String) -> Bool {
    guard !closed, cleanedUnavailableThreads[id] != true else { return false }
    let first = cleanedUnavailableThreads[id] == nil
    cleanedUnavailableThreads[id] = didDelete(id)
    return first
  }

  func awaitsParentCheck(_ id: String) -> Bool {
    removedByCachedSnapshot.contains(id)
  }

  private func acknowledgeCleanup(_ list: ChatSync.ThreadList, confirming confirmed: Set<String>)
    async
  {
    guard list.isPersisted, !cleanedUnavailableThreads.isEmpty else { return }
    let listed = Set(list.threads.map(\.id))
    // A parent probe may have written a tombstone after this snapshot was read.
    let newlyAbsent = confirmed.subtracting(listed).subtracting(list.deletedThreadIDs)
    let cleaned = list.removalsToAcknowledge.union(newlyAbsent).filter {
      cleanedUnavailableThreads[$0] == true
    }
    // Keep guards only for rows or delete events still present in the shared projection.
    let referenced = list.deletedThreadIDs.union(listed).subtracting(cleaned)
    cleanedUnavailableThreads = cleanedUnavailableThreads.filter {
      !$0.value || referenced.contains($0.key)
    }
    await sync.acknowledgeRemovedThreads(cleaned)
  }

  @discardableResult
  func confirmUnavailable(_ id: String) -> Bool {
    guard retireThread(id) else { return false }
    publishThreads(threads)
    // A detail response can arrive before the corresponding list event, even across a restart.
    let task = Task { [sync] in
      do { try await sync.markThreadUnavailable(id) } catch {
        Logger(subsystem: "ai.okou.ios", category: "ChatCache")
          .error(
            "event=chat.cache.unavailable.save.failed error=\(error.localizedDescription, privacy: .private)"
          )
      }
    }
    lifecycleTasks.track(task)
    return true
  }

  func canWrite(_ id: String) -> Bool {
    actions.canWrite(id)
  }

  @discardableResult
  func delete(
    _ id: String, eventID: String,
    onFailure: (@MainActor (String) -> Void)? = nil
  ) async -> Bool {
    return await actions.delete(id, eventID: eventID, onFailure: onFailure)
  }
}
