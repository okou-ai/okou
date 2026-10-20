import ChatDomain
import Foundation
import OSLog

public actor ChatSync {
  private let client: APIClient
  private let chatEventSchemaVersion = 8
  private let threadEventRebaseThreshold = 100
  private let cache: ChatCache?
  private var histories: [String: CachedHistory] = [:]
  private var readingHistories = Set<String>()
  private var historyWaiters: [String: [CheckedContinuation<Void, Never>]] = [:]

  public init(client: APIClient, cache: ChatCache? = nil) {
    self.client = client
    self.cache = cache
  }

  /// Dirty rows survive a failed write until a later catch-up persists them.
  public func releaseHistory(threadID: String) -> Bool {
    guard !readingHistories.contains(threadID) else { return false }
    if cache != nil, let history = histories[threadID], history.replaced || !history.newRows.isEmpty
    {
      return false
    }
    histories[threadID] = nil
    return true
  }

  public func cachedThreads() async -> [ChatThread]? {
    guard let cached = await readCachedThreadList() else { return nil }
    return ChatThreadReplay.sidebarOrder(
      ChatThreadReplay.replay(
        snapshot: cached.snapshot.map(\.thread), events: cached.events.map(\.change)))
  }

  public func cachedHistory(threadID: String) async -> ChatHistory? {
    guard let cached = await readCachedHistory(threadID: threadID) else { return nil }
    return try? ChatEventProjection.history(rows: cached.rows.map(\.event), recovering: false)
  }

  public func threads() async throws -> [ChatThread] {
    try await threadsWithIndicators().threads
  }

  public func threadsWithIndicators() async throws -> (
    threads: [ChatThread], indicators: Indicators?
  ) {
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
    if !state.replaced && state.events.count > threadEventRebaseThreshold {
      let rebased: ThreadListState?
      do {
        rebased = try await fetchThreadSnapshot()
      } catch let error as APIClientError where error.statusCode == 401 || error.statusCode == 426 {
        throw error
      } catch {
        Logger(subsystem: "ai.okou.ios", category: "ChatCache")
          .debug(
            "Skipping chat list snapshot rebase: \(error.localizedDescription, privacy: .public)")
        rebased = nil
      }
      if let rebased { state = try await catchUpThreadEvents(rebased) }
    }
    await persistThreadList(state)
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
            "Cannot remove deleted chat history: \(error.localizedDescription, privacy: .public)")
      }
    }
    let indicators: Indicators?
    do {
      indicators = try await self.indicators()
    } catch let error as APIClientError where error.statusCode == 401 || error.statusCode == 426 {
      throw error
    } catch is CancellationError {
      throw CancellationError()
    } catch {
      indicators = nil
    }
    let threads = current.map { thread in
      var updated = thread
      updated.indicator = indicators?.threads[thread.id]
      updated.unreadAt = indicators?.unreadAt[thread.id]
      if thread.isMuted && updated.indicator == .unread { updated.indicator = nil }
      return updated
    }
    return (threads, indicators)
  }

  public func indicators() async throws -> Indicators {
    try await client.request("/api/indicators")
  }

  private struct ThreadListState {
    var snapshot: [ThreadProjection]
    var snapshotData: Data
    var snapshotCursor: ChatCacheCursor
    var events: [ThreadEvent]
    var newEvents: [ChatCacheEvent]
    var cursor: ChatCacheCursor
    var replaced: Bool
    var cursorFromServerSnapshot: Bool
  }

  private func readCachedThreadList() async -> ThreadListState? {
    guard let cache else { return nil }
    do {
      guard let stored = try await cache.loadThreadList() else { return nil }
      let snapshot = try APIClient.decoder().decode(
        ThreadSnapshotArchive.self, from: stored.snapshot
      ).chatThreads
      let events = try stored.events.map { row in
        let event = try APIClient.decoder().decode(ThreadEvent.self, from: row.data)
        guard event.id == row.id, event.seqId == row.seqID else {
          throw ChatError.invalidContract("Cached chat list event identity is invalid.")
        }
        return event
      }
      var previous = stored.snapshotCursor.seqID
      for event in events {
        guard event.seqId > previous else {
          throw ChatError.invalidContract("Cached chat list event order is invalid.")
        }
        previous = event.seqId
      }
      return ThreadListState(
        snapshot: snapshot, snapshotData: stored.snapshot,
        snapshotCursor: stored.snapshotCursor, events: events, newEvents: [],
        cursor: events.last.map { ChatCacheCursor(eventID: $0.id, seqID: $0.seqId) }
          ?? stored.snapshotCursor,
        replaced: false, cursorFromServerSnapshot: false)
    } catch {
      Logger(subsystem: "ai.okou.ios", category: "ChatCache")
        .error("Cannot read cached chat list: \(error.localizedDescription, privacy: .public)")
      return nil
    }
  }

  private func fetchThreadSnapshot() async throws -> ThreadListState {
    let response = try await client.data("/api/chat-threads/snapshot")
    let snapshot = try Self.decode(ThreadSnapshot.self, from: response.data)
    let archiveData: Data
    let latestEventID: String?
    let latestSeqID: Int?
    switch snapshot {
    case .inline(_, let eventID, let seqID):
      // The inline response is an empty scope on current APIs. Keep the exact
      // projection JSON for a rollback-window response as well.
      guard let object = try JSONSerialization.jsonObject(with: response.data) as? [String: Any],
        let threads = object["chatThreads"]
      else { throw APIClientError.incompatibleData }
      archiveData = try JSONSerialization.data(withJSONObject: ["chatThreads": threads])
      latestEventID = eventID
      latestSeqID = seqID
    case .remote(let url, let eventID, let seqID):
      archiveData = try await client.downloadSnapshot(url)
      latestEventID = eventID
      latestSeqID = seqID
    }
    let projections = try Self.decode(ThreadSnapshotArchive.self, from: archiveData).chatThreads
    let cursor = ChatCacheCursor(eventID: latestEventID, seqID: latestSeqID ?? 0)
    return ThreadListState(
      snapshot: projections, snapshotData: archiveData, snapshotCursor: cursor,
      events: [], newEvents: [], cursor: cursor, replaced: true,
      cursorFromServerSnapshot: true)
  }

  private func catchUpThreadEvents(_ initial: ThreadListState) async throws -> ThreadListState {
    var state = initial
    while true {
      do {
        try await loadThreadEventTail(into: &state)
        return state
      } catch let error as APIClientError where error.statusCode == 410 {
        guard !state.cursorFromServerSnapshot else {
          throw ChatError.invalidContract(
            "Chat list cursor expired immediately after its snapshot.")
        }
        state = try await fetchThreadSnapshot()
      }
    }
  }

  private func loadThreadEventTail(into state: inout ThreadListState) async throws {
    while true {
      let query =
        state.cursor.seqID > 0
        ? [URLQueryItem(name: "sinceSeqId", value: String(state.cursor.seqID))] : []
      let response = try await client.data("/api/chat-threads/events", query: query)
      let page = try Self.decode(ThreadEventsPage.self, from: response.data)
      let rawEvents = try Self.rawArray("events", in: response.data)
      guard page.events.count == rawEvents.count else { throw APIClientError.incompatibleData }
      for (event, data) in zip(page.events, rawEvents) {
        guard event.seqId > state.cursor.seqID,
          !state.events.contains(where: { $0.id == event.id })
        else { throw ChatError.invalidContract("Chat list events are not ordered.") }
        state.events.append(event)
        state.newEvents.append(ChatCacheEvent(id: event.id, seqID: event.seqId, data: data))
        state.cursor = ChatCacheCursor(eventID: event.id, seqID: event.seqId)
      }
      if !page.events.isEmpty { state.cursorFromServerSnapshot = false }
      if !page.hasMore { return }
      if page.events.isEmpty {
        throw ChatError.invalidContract("Chat list cursor did not advance.")
      }
    }
  }

  private func persistThreadList(_ state: ThreadListState) async {
    guard let cache, state.replaced || !state.newEvents.isEmpty else { return }
    do {
      if state.replaced {
        try await cache.replaceThreadList(
          snapshot: state.snapshotData, cursor: state.snapshotCursor, events: state.newEvents)
      } else {
        try await cache.appendThreadEvents(state.newEvents)
      }
    } catch {
      Logger(subsystem: "ai.okou.ios", category: "ChatCache")
        .error("Cannot save chat list cache: \(error.localizedDescription, privacy: .public)")
    }
  }

  private static func decode<Value: Decodable>(_ type: Value.Type, from data: Data) throws -> Value
  {
    do { return try APIClient.decoder().decode(type, from: data) } catch {
      throw APIClientError.incompatibleData
    }
  }

  private static func rawArray(_ key: String, in data: Data) throws -> [Data] {
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      let values = object[key] as? [Any]
    else { throw APIClientError.incompatibleData }
    return try values.map { value in
      guard JSONSerialization.isValidJSONObject(value) else {
        throw APIClientError.incompatibleData
      }
      return try JSONSerialization.data(withJSONObject: value)
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
      try Self.validate(rows: rows, threadID: id, after: cursors[id]?.lastSeqId ?? 0)
      guard rawEvents[id]?.count == rows.count else { throw APIClientError.incompatibleData }
    }
    for id in ids {
      try Task.checkCancellation()
      let cursor = cursors[id] ?? .start
      var rebuilt: CachedHistory?
      if missing.contains(id) {
        // Network work stays outside the per-thread read lock. Opening the chat can overtake it.
        let snapshot = try await loadSnapshot(threadID: id)
        rebuilt = try await catchUpHistory(threadID: id, initial: snapshot)
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
      let saved = await persistHistory(next, threadID: id)
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
    // Actor methods can interleave at every network/cache await. Serialize each
    // thread's catch-up and durable cursor update, including calls from Stop.
    if !readingHistories.insert(threadID).inserted {
      await withCheckedContinuation { historyWaiters[threadID, default: []].append($0) }
    }
    defer { finishHistoryRead(threadID: threadID) }
    try Task.checkCancellation()
    return try await loadHistory(threadID: threadID)
  }

  private func finishHistoryRead(threadID: String) {
    if var waiters = historyWaiters[threadID], !waiters.isEmpty {
      let next = waiters.removeFirst()
      historyWaiters[threadID] = waiters.isEmpty ? nil : waiters
      next.resume()
    } else {
      readingHistories.remove(threadID)
    }
  }

  private func loadHistory(threadID: String) async throws -> ChatHistory {
    let cached = await readCachedHistory(threadID: threadID)
    var history: CachedHistory
    if let cached {
      history = cached
    } else {
      history = try await loadSnapshot(threadID: threadID)
    }
    history = try await catchUpHistory(threadID: threadID, initial: history)
    if await persistHistory(history, threadID: threadID) {
      history.newRows = []
      history.replaced = false
    }
    history.cursorFromServerSnapshot = false
    histories[threadID] = history
    let detail: ThreadDetail = try await client.request("/api/chat-threads/\(threadID)")
    return try ChatEventProjection.history(
      rows: history.rows.map(\.event), recovering: detail.cancellationRecoveryPending)
  }

  private func loadSnapshot(threadID: String) async throws -> CachedHistory {
    let snapshot: EventSnapshot
    do {
      snapshot = try await client.request(
        "/api/chat-threads/\(threadID)/event-snapshot")
    } catch let error as APIClientError
      where error.statusCode == 404
      && error.serverCode == "CHAT_EVENT_SNAPSHOT_NOT_FOUND"
    {
      return CachedHistory(
        rows: [], rawRows: [], newRows: [], cursor: .start, replaced: true,
        cursorFromServerSnapshot: true)
    }
    let data = try await client.downloadSnapshot(snapshot.url)
    // URLSession decompresses HTTP Content-Encoding: gzip before delivering data.
    guard let text = String(data: data, encoding: .utf8) else {
      throw ChatError.invalidContract("The history snapshot is not UTF-8 NDJSON.")
    }
    if !text.isEmpty && !text.hasSuffix("\n") {
      throw ChatError.invalidContract("The history snapshot is not NDJSON.")
    }
    var rows: [ChatEventRow] = []
    var rawRows: [ChatCacheEvent] = []
    for line in text.split(separator: "\n")
    where !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      let raw = Data(line.utf8)
      let row = try Self.decode(ChatEventRow.self, from: raw)
      rows.append(row)
      rawRows.append(ChatCacheEvent(id: row.id, seqID: row.seqId, data: raw))
    }
    try Self.validate(rows: rows, threadID: threadID, after: 0)
    let cursor = rows.last.map { EventCursor(lastEventId: $0.id, lastSeqId: $0.seqId) } ?? .start
    guard snapshot.cursor.isValid, snapshot.cursor == cursor else {
      throw ChatError.invalidContract("The history snapshot does not match its cursor.")
    }
    return CachedHistory(
      rows: rows, rawRows: rawRows, newRows: rawRows, cursor: cursor, replaced: true,
      cursorFromServerSnapshot: true)
  }

  private func readCachedHistory(threadID: String) async -> CachedHistory? {
    if let memory = histories[threadID] { return memory }
    guard let cache else { return nil }
    do {
      guard let stored = try await cache.loadHistory(threadID: threadID),
        stored.schemaVersion == chatEventSchemaVersion
      else { return nil }
      let rows = try stored.rows.map { entry in
        let row = try Self.decode(ChatEventRow.self, from: entry.data)
        guard row.id == entry.id, row.seqId == entry.seqID else {
          throw ChatError.invalidContract("Cached chat event identity is invalid.")
        }
        return row
      }
      try Self.validate(rows: rows, threadID: threadID, after: 0)
      guard stored.cursor.eventID == rows.last?.id,
        stored.cursor.seqID == (rows.last?.seqId ?? 0)
      else { throw ChatError.invalidContract("Cached chat history cursor is invalid.") }
      return CachedHistory(
        rows: rows, rawRows: stored.rows, newRows: [],
        cursor: EventCursor(lastEventId: stored.cursor.eventID, lastSeqId: stored.cursor.seqID),
        replaced: false, cursorFromServerSnapshot: false)
    } catch {
      Logger(subsystem: "ai.okou.ios", category: "ChatCache")
        .error("Cannot read cached history: \(error.localizedDescription, privacy: .public)")
      return nil
    }
  }

  private func catchUpHistory(threadID: String, initial: CachedHistory) async throws
    -> CachedHistory
  {
    var history = initial
    while true {
      do {
        try await loadHistoryTail(threadID: threadID, into: &history)
        return history
      } catch let error as APIClientError where error.statusCode == 410 {
        guard !history.cursorFromServerSnapshot else {
          throw ChatError.invalidContract(
            "Chat history cursor expired immediately after its snapshot.")
        }
        history = try await loadSnapshot(threadID: threadID)
      }
    }
  }

  private func loadHistoryTail(threadID: String, into history: inout CachedHistory) async throws {
    var confirmFreshTail = history.replaced
    while true {
      var query = [
        URLQueryItem(name: "sinceSeqId", value: String(history.cursor.lastSeqId)),
        URLQueryItem(name: "limit", value: "50"),
      ]
      if let eventID = history.cursor.lastEventId {
        query.append(URLQueryItem(name: "sinceEventId", value: eventID))
      }
      let response = try await client.data(
        "/api/chat-threads/\(threadID)/event-rows", query: query)
      let page = try Self.decode(EventRowsPage.self, from: response.data)
      let rawRows = try Self.rawArray("rows", in: response.data)
      guard page.rows.count == rawRows.count else { throw APIClientError.incompatibleData }
      try Self.validate(rows: page.rows, threadID: threadID, after: history.cursor.lastSeqId)
      let existingIDs = Set(history.rows.map(\.id))
      guard page.rows.allSatisfy({ !existingIDs.contains($0.id) }) else {
        throw ChatError.invalidContract("Chat history repeats an existing event identity.")
      }
      guard page.cursor.isValid,
        page.cursor
          == (page.rows.last.map { EventCursor(lastEventId: $0.id, lastSeqId: $0.seqId) }
            ?? history.cursor),
        !page.hasMore || !page.rows.isEmpty
      else { throw ChatError.invalidContract("Chat history cursor is inconsistent.") }
      for (row, raw) in zip(page.rows, rawRows) {
        let entry = ChatCacheEvent(id: row.id, seqID: row.seqId, data: raw)
        history.rawRows.append(entry)
        history.newRows.append(entry)
      }
      history.rows.append(contentsOf: page.rows)
      history.cursor = page.cursor
      if !page.rows.isEmpty { history.cursorFromServerSnapshot = false }
      let shouldContinue = page.hasMore || confirmFreshTail
      confirmFreshTail = false
      if !shouldContinue { return }
    }
  }

  private func persistHistory(_ history: CachedHistory, threadID: String) async -> Bool {
    guard let cache else { return false }
    guard history.replaced || !history.newRows.isEmpty else { return true }
    let cursor = ChatCacheCursor(
      eventID: history.cursor.lastEventId, seqID: history.cursor.lastSeqId)
    do {
      if history.replaced {
        try await cache.replaceHistory(
          threadID: threadID, rows: history.rawRows, cursor: cursor,
          schemaVersion: chatEventSchemaVersion)
      } else {
        try await cache.appendHistory(
          threadID: threadID, rows: history.newRows, cursor: cursor,
          schemaVersion: chatEventSchemaVersion)
      }
      return true
    } catch {
      Logger(subsystem: "ai.okou.ios", category: "ChatCache")
        .error("Cannot save chat history cache: \(error.localizedDescription, privacy: .public)")
      return false
    }
  }

  private static func validate(rows: [ChatEventRow], threadID: String, after: Int) throws {
    var previous = after
    var identities = Set<String>()
    for row in rows {
      guard row.chatThreadId == threadID, row.seqId > previous, identities.insert(row.id).inserted
      else {
        throw ChatError.invalidContract("Chat history contains an invalid event sequence.")
      }
      previous = row.seqId
    }
  }

  private struct CachedHistory: Sendable {
    var rows: [ChatEventRow]
    var rawRows: [ChatCacheEvent]
    var newRows: [ChatCacheEvent]
    var cursor: EventCursor
    var replaced: Bool
    var cursorFromServerSnapshot: Bool
  }
}

extension ChatSync {
  public func searchMessages(keyword: String) async throws -> [ChatSearchResult] {
    struct Response: Decodable { let results: [ChatSearchResult] }
    let response: Response = try await client.request(
      "/api/chat/search", query: [URLQueryItem(name: "keyword", value: keyword)])
    return response.results
  }
}
