import ChatDomain
import Foundation
import OSLog

public actor ChatSync {
  public struct ThreadList: Sendable {
    public let threads: [ChatThread]
    public let eventIDs: Set<String>
    public let cursor: ChatCacheCursor
  }

  public struct ThreadListWithIndicators: Sendable {
    public let threads: [ChatThread]
    public let indicators: Indicators?
    public let eventIDs: Set<String>
    public let cursor: ChatCacheCursor
  }

  let client: APIClient
  private let chatEventSchemaVersion = 8
  private typealias CachedHistory = ChatHistoryIO.State
  private var historyIO: ChatHistoryIO {
    ChatHistoryIO(client: client, cache: cache, schemaVersion: chatEventSchemaVersion)
  }
  private func readCachedHistory(threadID: String) async -> CachedHistory? {
    await historyIO.readCachedHistory(threadID: threadID, memory: histories[threadID])
  }
  private let threadEventRebaseThreshold = 100
  let cache: ChatCache?
  private var indicatorState = ChatIndicatorCacheState()
  private var histories: [String: CachedHistory] = [:]
  private var readingHistories = Set<String>()
  private struct HistoryWaiter {
    let id: UUID
    let continuation: CheckedContinuation<Bool, Never>
  }
  private var historyWaiters: [String: [HistoryWaiter]] = [:]

  public init(client: APIClient, cache: ChatCache? = nil) {
    self.client = client
    self.cache = cache
  }

  /// Dirty rows survive a failed write until a later catch-up persists them.
  public func releaseHistory(threadID: String) -> Bool {
    guard !readingHistories.contains(threadID) else { return false }
    if cache != nil,
      let history = histories[threadID], history.replaced || !history.newRows.isEmpty
    {
      return false
    }
    histories[threadID] = nil
    return true
  }

  public func cachedThreads() async -> [ChatThread]? {
    await cachedThreadList()?.threads
  }

  /// A committed list at or below `sequence` needs no new presentation projection.
  public func cachedThreadList(newerThan sequence: Int? = nil) async -> (
    threads: [ChatThread], cursor: ChatCacheCursor
  )? {
    guard let cached = await readCachedThreadList(newerThan: sequence) else { return nil }
    return (
      ChatThreadReplay.sidebarOrder(
        ChatThreadReplay.replay(
          snapshot: cached.snapshot.map(\.thread), events: cached.events.map(\.change))),
      cached.cursor
    )
  }

  public func cachedHistory(threadID: String) async -> ChatHistory? {
    guard let cached = await readCachedHistory(threadID: threadID) else { return nil }
    return try? ChatEventProjection.history(rows: cached.rows.map(\.event), recovering: false)
  }

  public func threads() async throws -> [ChatThread] {
    try await threadsWithIndicators().threads
  }

  public func threadsWithIndicators() async throws -> ThreadListWithIndicators {
    let result = try await threadList()
    let indicators: Indicators?
    do {
      indicators = try await self.indicators()
    } catch let error as APIClientError where error.statusCode == 401 || error.statusCode == 426 {
      throw error
    } catch is CancellationError {
      throw CancellationError()
    } catch {
      Logger(subsystem: "ai.okou.ios", category: "ChatSync")
        .info(
          "event=chat.indicators.read.failed error_domain=\((error as NSError).domain, privacy: .public) error_code=\((error as NSError).code) error=\(error.localizedDescription, privacy: .private)"
        )
      indicators = nil
    }
    let threads = result.threads.map { thread in
      var updated = thread
      updated.indicator = indicators?.threads[thread.id]
      updated.unreadAt = indicators?.unreadAt[thread.id]
      if thread.isMuted && updated.indicator == .unread { updated.indicator = nil }
      return updated
    }
    return ThreadListWithIndicators(
      threads: threads, indicators: indicators, eventIDs: result.eventIDs, cursor: result.cursor)
  }

  /// Synchronize list metadata independently of unread and running-state reads.
  public func threadList() async throws -> ThreadList {
    try await synchronizeThreadList(requirePersistence: false)
  }

  /// Cache navigation without fetching indicators or marking any conversation read.
  public func prefetchThreadList() async throws {
    _ = try await synchronizeThreadList(requirePersistence: true)
  }

  private func synchronizeThreadList(requirePersistence: Bool) async throws -> ThreadList {
    let cached = await readCachedThreadList()
    var state: ThreadListState
    if let cached {
      state = cached
    } else {
      state = try await fetchThreadSnapshot()
    }
    let previousIDs = Set(
      ChatThreadReplay.replay(
        snapshot: state.snapshot.map(\.thread), events: state.events.map(\.change)
      ).map(\.id))
    state = try await catchUpThreadEvents(state)
    // A snapshot rebase can compact events observed during this catch-up.
    var eventIDs = Set(state.events.map(\.id))
    if !state.replaced && state.events.count > threadEventRebaseThreshold {
      let rebased: ThreadListState?
      do {
        rebased = try await fetchThreadSnapshot()
      } catch let error as APIClientError where error.statusCode == 401 || error.statusCode == 426 {
        throw error
      } catch {
        Logger(subsystem: "ai.okou.ios", category: "ChatCache")
          .debug(
            "event=chat.cache.list.rebase.failed error_domain=\((error as NSError).domain, privacy: .public) error_code=\((error as NSError).code) error=\(error.localizedDescription, privacy: .private)"
          )
        rebased = nil
      }
      if let rebased { state = try await catchUpThreadEvents(rebased) }
    }
    eventIDs.formUnion(state.events.map(\.id))
    if !(await persistThreadList(state)), requirePersistence { throw ChatCacheError.unavailable }
    if let durable = await readCachedThreadList(newerThan: state.cursor.seqID) {
      state = durable
      eventIDs.formUnion(durable.events.map(\.id))
    }
    let current = ChatThreadReplay.sidebarOrder(
      ChatThreadReplay.replay(
        snapshot: state.snapshot.map(\.thread), events: state.events.map(\.change)))
    for removedID in previousIDs.subtracting(current.map(\.id)) {
      histories.removeValue(forKey: removedID)
      do {
        try await cache?.deleteHistory(threadID: removedID)
      } catch {
        Logger(subsystem: "ai.okou.ios", category: "ChatCache")
          .error(
            "event=chat.cache.history.delete.failed error_domain=\((error as NSError).domain, privacy: .public) error_code=\((error as NSError).code) error=\(error.localizedDescription, privacy: .private)"
          )
      }
    }
    return ThreadList(threads: current, eventIDs: eventIDs, cursor: state.cursor)
  }

  public func cachedIndicators() async -> CachedChatIndicators? {
    guard let cache else { return indicatorState.snapshot }
    do {
      return try await cache.loadIndicators()
    } catch {
      logIndicatorCacheFailure(error)
      // A process-local counter cannot stand in for the shared cache revision.
      // The mounted list already owns its last confirmed presentation.
      return nil
    }
  }

  public func indicators() async throws -> Indicators {
    let localRequest = indicatorState.beginRead()
    let request: ChatIndicatorsRead?
    do { request = try await cache?.beginIndicatorsRead() } catch {
      logIndicatorCacheFailure(error)
      request = nil
    }
    let result: Indicators = try await client.request("/api/indicators")
    try Task.checkCancellation()
    let threads = await cachedThreads() ?? []
    try Task.checkCancellation()
    guard indicatorState.accepts(localRequest) else {
      guard let current = await cachedIndicators() else { throw CancellationError() }
      return current.indicators
    }
    if let request, let cache {
      do {
        let saved = try await cache.saveIndicators(result, threads: threads, request: request)
        if !saved {
          // A newer request or confirmed mutation won in the other process.
          guard let current = try await cache.loadIndicators() else { throw CancellationError() }
          indicatorState.snapshot = current
          return current.indicators
        }
      } catch is CancellationError {
        throw CancellationError()
      } catch { logIndicatorCacheFailure(error) }
    }
    try Task.checkCancellation()
    guard indicatorState.save(result, threads: threads, request: localRequest) else {
      guard let current = await cachedIndicators() else { throw CancellationError() }
      return current.indicators
    }
    return result
  }

  func changeReadState(_ change: ChatReadStateChange) async {
    // Fence the in-flight local readers before suspending for disk metadata.
    indicatorState.change(change)
    let threads: [ChatThread]
    if case .invalidated = change {
      threads = []
    } else {
      threads = await cachedThreads() ?? []
    }
    do { try await cache?.changeReadState(change, threads: threads) } catch {
      logIndicatorCacheFailure(error)
    }
  }

  private func logIndicatorCacheFailure(_ error: Error) {
    Logger(subsystem: "ai.okou.ios", category: "ChatCache")
      .error(
        "event=chat.cache.unread.failed error_domain=\((error as NSError).domain, privacy: .public) error_code=\((error as NSError).code) error=\(error.localizedDescription, privacy: .private)"
      )
  }

  /// Both push entry points own and cancel the optional indicators read. It
  /// starts alongside history, but cannot extend the core prefetch deadline.
  public func prefetchNotification(threadID: String, runID: String, tailOnly: Bool = false)
    async throws -> PrefetchReceipt
  {
    try await withThrowingTaskGroup(of: PrefetchReceipt?.self) { group in
      group.addTask {
        do { _ = try await self.indicators() } catch {
          if !Task.isCancelled {
            Logger(subsystem: "ai.okou.ios", category: "ChatSync")
              .info(
                "event=notifications.unread.read.failed error_domain=\((error as NSError).domain, privacy: .public) error_code=\((error as NSError).code) error=\(error.localizedDescription, privacy: .private)"
              )
          }
        }
        return nil
      }
      group.addTask {
        let receipt: PrefetchReceipt
        if tailOnly {
          receipt = try await self.prefetchHistoryTail(threadID: threadID, runID: runID)
        } else {
          receipt = try await self.prefetchHistory(threadID: threadID, runID: runID)
        }
        try Task.checkCancellation()
        try await self.prefetchThreadList()
        return receipt
      }
      while let result = try await group.next() {
        if let result {
          group.cancelAll()
          return result
        }
      }
      throw CancellationError()
    }
  }

  /// Populate unopened conversations without retaining their projections or blocking a foreground read.
  public func warmHistories(threadIDs: [String]) async throws {
    guard let cache else { return }
    let ids = Array(Set(threadIDs)).sorted()
    guard !ids.isEmpty else { return }
    var cursors: [String: EventCursor] = [:]
    for id in ids {
      try Task.checkCancellation()
      if let memory = histories[id] {
        cursors[id] = memory.cursor
      } else if let cursor = try await cache.loadHistoryCursor(
        threadID: id, schemaVersion: chatEventSchemaVersion)
      {
        cursors[id] = EventCursor(lastEventId: cursor.eventID, lastSeqId: cursor.seqID)
      }
    }
    let body = try JSONSerialization.data(
      withJSONObject: ids.map { [$0, cursors[$0]?.lastSeqId ?? 0] as [Any] })
    let data = try await client.data("/api/chat/events/catch-up", method: "POST", body: body).data
    let response = try Self.decode(EventCatchUpResponse.self, from: data)
    let missing = Set(response.notFoundThreads)
    guard missing.count == response.notFoundThreads.count,
      missing.isDisjoint(with: response.events.keys),
      missing.union(response.events.keys) == Set(ids),
      let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      let rawEvents = object["events"] as? [String: [Any]]
    else { throw ChatError.invalidContract("Chat history catch-up returned an invalid partition.") }
    for (id, rows) in response.events {
      try ChatHistoryIO.validate(rows: rows, threadID: id, after: cursors[id]?.lastSeqId ?? 0)
      guard rawEvents[id]?.count == rows.count else { throw APIClientError.incompatibleData }
    }
    for id in ids {
      try Task.checkCancellation()
      let cursor = cursors[id] ?? .start
      var rebuilt: CachedHistory?
      if missing.contains(id) {
        // Network work stays outside the per-thread read lock. Opening the chat can overtake it.
        let snapshot = try await historyIO.loadSnapshot(threadID: id)
        rebuilt = try await historyIO.catchUpHistory(threadID: id, initial: snapshot)
      } else if response.events[id]?.isEmpty == true, cursors[id] != nil {
        continue
      }
      guard readingHistories.insert(id).inserted else { continue }
      defer { finishHistoryRead(threadID: id) }
      let current = await readCachedHistory(threadID: id)
      try Task.checkCancellation()
      // A foreground read may have advanced while the batch was in flight.
      guard (current?.cursor ?? .start) == cursor else { continue }
      var next: CachedHistory
      if let rebuilt {
        next = rebuilt
      } else {
        next =
          current
          ?? CachedHistory(
            rows: [], rawRows: [], newRows: [], cursor: .start,
            replaced: true, cursorFromServerSnapshot: false)
        guard let rows = response.events[id], let raw = rawEvents[id] else {
          throw APIClientError.incompatibleData
        }
        let entries = try zip(rows, raw).map { row, value in
          ChatCacheEvent(
            id: row.id, seqID: row.seqId, data: try JSONSerialization.data(withJSONObject: value))
        }
        next.rows.append(contentsOf: rows)
        next.rawRows.append(contentsOf: entries)
        next.newRows.append(contentsOf: entries)
        if let last = rows.last {
          next.cursor = EventCursor(lastEventId: last.id, lastSeqId: last.seqId)
        }
      }
      let saved = await historyIO.persistHistory(next, threadID: id)
      if saved {
        next.newRows = []
        next.replaced = false
      }
      next.cursorFromServerSnapshot = false
      // Only resident readers retain raw history, including their dirty-write recovery state.
      // An unsuccessful speculative write must not fill memory with unopened conversations.
      if histories[id] != nil { histories[id] = next }
    }
  }

  public func activitySummary(threadID: String, runID: String) async throws -> ChatActivitySummary {
    try await client.activitySummary(threadID: threadID, runID: runID)
  }

  public func history(threadID: String) async throws -> ChatHistory {
    let history = try await eventHistory(threadID: threadID)
    return try await history.withCancellationRecoveryPending(
      cancellationRecoveryPending(threadID: threadID))
  }

  /// Durable messages do not depend on the separate cancellation-recovery read.
  public func eventHistory(threadID: String) async throws -> ChatHistory {
    let history = try await readHistory(threadID: threadID, requirePersistence: false)
    return try ChatEventProjection.history(rows: history.rows.map(\.event), recovering: false)
  }

  public func cancellationRecoveryPending(threadID: String) async throws -> Bool {
    let detail: ThreadDetail = try await client.request("/api/chat-threads/\(threadID)")
    return detail.cancellationRecoveryPending
  }

  public struct PrefetchReceipt: Sendable {
    public let lastSeqID: Int
    public let containsRun: Bool
  }

  /// Extension catch-up reads only the durable cursor and one event page at a time.
  /// SQLite arbitrates overlapping app/extension writers; no UI history is retained.
  public func prefetchHistoryTail(threadID: String, runID: String) async throws -> PrefetchReceipt {
    guard let cache else { throw ChatCacheError.unavailable }
    var cursor = try await cache.loadHistoryCursor(
      threadID: threadID, schemaVersion: chatEventSchemaVersion)
    var fromSnapshot = false
    var confirmFreshTail = false
    func rebuild() async throws -> ChatCacheCursor {
      let snapshot = try await historyIO.loadSnapshot(threadID: threadID)
      guard await historyIO.persistHistory(snapshot, threadID: threadID),
        let cursor = try await cache.loadHistoryCursor(
          threadID: threadID, schemaVersion: chatEventSchemaVersion)
      else { throw ChatCacheError.unavailable }
      return cursor
    }
    if cursor == nil {
      cursor = try await rebuild()
      fromSnapshot = true
      confirmFreshTail = true
    }
    while let current = cursor {
      try Task.checkCancellation()
      do {
        var query = [
          URLQueryItem(name: "sinceSeqId", value: String(current.seqID)),
          URLQueryItem(name: "limit", value: "50")
        ]
        if let id = current.eventID { query.append(URLQueryItem(name: "sinceEventId", value: id)) }
        let response = try await client.data(
          "/api/chat-threads/\(threadID)/event-rows", query: query)
        let page = try Self.decode(EventRowsPage.self, from: response.data)
        let raw = try Self.rawArray("rows", in: response.data)
        try ChatHistoryIO.validate(rows: page.rows, threadID: threadID, after: current.seqID)
        let expected =
          page.rows.last.map { EventCursor(lastEventId: $0.id, lastSeqId: $0.seqId) }
          ?? EventCursor(lastEventId: current.eventID, lastSeqId: current.seqID)
        guard page.rows.count == raw.count, page.cursor.isValid, page.cursor == expected,
          !page.hasMore || !page.rows.isEmpty
        else { throw APIClientError.incompatibleData }
        let entries = zip(page.rows, raw).map { row, data in
          ChatCacheEvent(id: row.id, seqID: row.seqId, data: data)
        }
        try await cache.appendHistory(
          threadID: threadID, rows: entries,
          cursor: ChatCacheCursor(eventID: page.cursor.lastEventId, seqID: page.cursor.lastSeqId),
          schemaVersion: chatEventSchemaVersion)
        cursor = try await cache.loadHistoryCursor(
          threadID: threadID, schemaVersion: chatEventSchemaVersion)
        if !page.rows.isEmpty { fromSnapshot = false }
        let more = page.hasMore || confirmFreshTail
        confirmFreshTail = false
        if !more { break }
      } catch let error as APIClientError where error.statusCode == 410 {
        guard !fromSnapshot else {
          throw ChatError.invalidContract("History cursor expired immediately after its snapshot.")
        }
        cursor = try await rebuild()
        fromSnapshot = true
        confirmFreshTail = true
      }
    }
    guard let cursor else { throw ChatCacheError.unavailable }
    return PrefetchReceipt(
      lastSeqID: cursor.seqID,
      containsRun: try await cache.containsRun(threadID: threadID, runID: runID))
  }

  /// Persist raw events without building UI projections or updating read cursors.
  @discardableResult
  public func prefetchHistory(threadID: String, runID: String? = nil) async throws
    -> PrefetchReceipt
  {
    let history = try await readHistory(threadID: threadID, requirePersistence: true)
    return PrefetchReceipt(
      lastSeqID: history.cursor.lastSeqId,
      containsRun: runID.map { id in
        history.rows.contains { $0.runId == id && $0.eventType.isTerminal }
      }
        ?? false)
  }

  private func readHistory(
    threadID: String, requirePersistence: Bool
  ) async throws -> CachedHistory {
    // Actor methods can interleave at every network/cache await. Serialize each
    // thread's catch-up and durable cursor update, including calls from Stop.
    if !readingHistories.insert(threadID).inserted {
      let id = UUID()
      let acquired = await withTaskCancellationHandler {
        await withCheckedContinuation { continuation in
          if Task.isCancelled {
            continuation.resume(returning: false)
          } else {
            historyWaiters[threadID, default: []].append(
              HistoryWaiter(id: id, continuation: continuation))
          }
        }
      } onCancel: {
        Task { await self.cancelHistoryWaiter(threadID: threadID, id: id) }
      }
      guard acquired else { throw CancellationError() }
    }
    defer { finishHistoryRead(threadID: threadID) }
    try Task.checkCancellation()
    return try await loadHistory(threadID: threadID, requirePersistence: requirePersistence)
  }

  private func cancelHistoryWaiter(threadID: String, id: UUID) {
    guard var waiters = historyWaiters[threadID],
      let index = waiters.firstIndex(where: { $0.id == id })
    else { return }
    let waiter = waiters.remove(at: index)
    historyWaiters[threadID] = waiters.isEmpty ? nil : waiters
    waiter.continuation.resume(returning: false)
  }

  private func finishHistoryRead(threadID: String) {
    if var waiters = historyWaiters[threadID], !waiters.isEmpty {
      let next = waiters.removeFirst()
      historyWaiters[threadID] = waiters.isEmpty ? nil : waiters
      next.continuation.resume(returning: true)
    } else {
      readingHistories.remove(threadID)
    }
  }

  private func loadHistory(
    threadID: String, requirePersistence: Bool
  ) async throws -> CachedHistory {
    let cached = await readCachedHistory(threadID: threadID)
    var history: CachedHistory
    if let cached {
      history = cached
    } else {
      history = try await historyIO.loadSnapshot(threadID: threadID)
    }
    history = try await historyIO.catchUpHistory(threadID: threadID, initial: history)
    if await historyIO.persistHistory(history, threadID: threadID) {
      history.newRows = []
      history.replaced = false
    } else if requirePersistence {
      throw ChatCacheError.unavailable
    }
    history.cursorFromServerSnapshot = false
    histories[threadID] = history
    if let durable = await readCachedHistory(threadID: threadID),
      durable.cursor.lastSeqId > history.cursor.lastSeqId
    {
      histories[threadID] = durable
      return durable
    }
    return history
  }
}
