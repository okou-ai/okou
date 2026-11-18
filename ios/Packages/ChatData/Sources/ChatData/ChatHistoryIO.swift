import ChatDomain
import Foundation
import OSLog

/// Snapshot/tail transport and durable history I/O; ChatSync retains resident state and read ownership.
struct ChatHistoryIO: Sendable {
  let client: APIClient
  let cache: ChatCache?
  let schemaVersion: Int

  func loadSnapshot(threadID: String) async throws -> State {
    let snapshot: EventSnapshot
    do {
      snapshot = try await client.request(
        "/api/chat-threads/\(threadID)/event-snapshot")
    } catch let error as APIClientError {
      guard error.statusCode == 404, error.serverCode == "CHAT_EVENT_SNAPSHOT_NOT_FOUND" else {
        throw error
      }
      return State(
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
      let row = try ChatSync.decode(ChatEventRow.self, from: raw)
      rows.append(row)
      rawRows.append(ChatCacheEvent(id: row.id, seqID: row.seqId, data: raw))
    }
    try Self.validate(rows: rows, threadID: threadID, after: 0)
    let cursor = rows.last.map { EventCursor(lastEventId: $0.id, lastSeqId: $0.seqId) } ?? .start
    guard snapshot.cursor.isValid, snapshot.cursor == cursor else {
      throw ChatError.invalidContract("The history snapshot does not match its cursor.")
    }
    return State(
      rows: rows, rawRows: rawRows, newRows: rawRows, cursor: cursor, replaced: true,
      cursorFromServerSnapshot: true)
  }

  func readCachedHistory(threadID: String, memory: State?) async -> State? {
    guard let cache else { return memory }
    if let memory {
      do {
        let cursor = try await cache.loadHistoryCursor(
          threadID: threadID, schemaVersion: schemaVersion)
        if (cursor?.seqID ?? 0) <= memory.cursor.lastSeqId { return memory }
      } catch { return memory }
    }
    // The NSE is a separate process; its committed cursor can outrun resident memory.
    do {
      guard let stored = try await cache.loadHistory(threadID: threadID),
        stored.schemaVersion == schemaVersion
      else { return nil }
      let decoder = APIClient.decoder()
      let rows = try stored.rows.map { entry in
        let row = try ChatSync.decode(ChatEventRow.self, from: entry.data, using: decoder)
        guard row.id == entry.id, row.seqId == entry.seqID else {
          throw ChatError.invalidContract("Cached chat event identity is invalid.")
        }
        return row
      }
      try Self.validate(rows: rows, threadID: threadID, after: 0)
      guard stored.cursor.eventID == rows.last?.id,
        stored.cursor.seqID == (rows.last?.seqId ?? 0)
      else { throw ChatError.invalidContract("Cached chat history cursor is invalid.") }
      return State(
        rows: rows, rawRows: stored.rows, newRows: [],
        cursor: EventCursor(lastEventId: stored.cursor.eventID, lastSeqId: stored.cursor.seqID),
        replaced: false, cursorFromServerSnapshot: false)
    } catch {
      Logger(subsystem: "ai.okou.ios", category: "ChatCache")
        .error(
          "event=chat.cache.history.read.failed error_domain=\((error as NSError).domain, privacy: .public) error_code=\((error as NSError).code) error=\(error.localizedDescription, privacy: .private)"
        )
      return nil
    }
  }

  func catchUpHistory(threadID: String, initial: State) async throws
    -> State
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

  func loadHistoryTail(threadID: String, into history: inout State) async throws {
    var confirmFreshTail = history.replaced
    while true {
      var query = [
        URLQueryItem(name: "sinceSeqId", value: String(history.cursor.lastSeqId)),
        URLQueryItem(name: "limit", value: "50")
      ]
      if let eventID = history.cursor.lastEventId {
        query.append(URLQueryItem(name: "sinceEventId", value: eventID))
      }
      let response = try await client.data(
        "/api/chat-threads/\(threadID)/event-rows", query: query)
      let page = try ChatSync.decode(EventRowsPage.self, from: response.data)
      let rawRows = try ChatSync.rawArray("rows", in: response.data)
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

  func persistHistory(_ history: State, threadID: String) async -> Bool {
    guard let cache else { return false }
    guard history.replaced || !history.newRows.isEmpty else { return true }
    let cursor = ChatCacheCursor(
      eventID: history.cursor.lastEventId, seqID: history.cursor.lastSeqId)
    do {
      if history.replaced {
        try await cache.replaceHistory(
          threadID: threadID, rows: history.rawRows, cursor: cursor,
          schemaVersion: schemaVersion)
      } else {
        try await cache.appendHistory(
          threadID: threadID, rows: history.newRows, cursor: cursor,
          schemaVersion: schemaVersion)
      }
      return true
    } catch {
      Logger(subsystem: "ai.okou.ios", category: "ChatCache")
        .error(
          "event=chat.cache.history.save.failed error_domain=\((error as NSError).domain, privacy: .public) error_code=\((error as NSError).code) error=\(error.localizedDescription, privacy: .private)"
        )
      return false
    }
  }

  static func validate(rows: [ChatEventRow], threadID: String, after: Int) throws {
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

  struct State: Sendable {
    var rows: [ChatEventRow]
    var rawRows: [ChatCacheEvent]
    var newRows: [ChatCacheEvent]
    var cursor: EventCursor
    var replaced: Bool
    var cursorFromServerSnapshot: Bool
  }
}
