import CryptoKit
import Foundation
import SQLite3

struct ChatCacheScope: Sendable {
  let apiBaseURL: URL
  let userID: String
  let workspaceID: String
}

struct ChatCacheCursor: Equatable, Sendable {
  let eventID: String?
  let seqID: Int
}

struct ChatCacheEvent: Equatable, Sendable {
  let id: String
  let seqID: Int
  let data: Data
}

struct CachedThreadList: Sendable {
  let snapshot: Data
  let snapshotCursor: ChatCacheCursor
  let events: [ChatCacheEvent]
}

struct CachedChatHistory: Sendable {
  let rows: [ChatCacheEvent]
  let cursor: ChatCacheCursor
  let schemaVersion: Int
}

enum ChatCacheError: Error {
  case missingThreadList
  case missingHistory
  case invalidCursor
  case invalidEventSequence
  case incompatibleHistorySchema
  case corrupt
  case unsupportedVersion
}

// Only server-confirmed snapshots and events enter this store. Presentation and
// optimistic state are reconstructed outside it, so a retry cannot persist a
// local guess as if it were an authoritative event.
actor ChatCache {
  private static let version = 1

  private let fileURL: URL
  private var connection: CacheDatabase?

  init(scope: ChatCacheScope, directory: URL? = nil) {
    let root =
      directory
      ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
      ?? FileManager.default.temporaryDirectory
    let identity = [scope.apiBaseURL.absoluteString, scope.userID, scope.workspaceID].joined(
      separator: "\u{0}")
    let digest = SHA256.hash(data: Data(identity.utf8))
    let filename = digest.map { String(format: "%02x", $0) }.joined() + ".sqlite"
    fileURL = root.appendingPathComponent("ChatCache", isDirectory: true)
      .appendingPathComponent(filename)
  }

  func loadThreadList() throws -> CachedThreadList? {
    try withDatabase { database in
      let snapshot = try database.prepare(
        "SELECT snapshot, snapshot_event_id, snapshot_seq_id FROM thread_list WHERE id = 1")
      guard try snapshot.step() else { return nil }
      let cursor = ChatCacheCursor(
        eventID: snapshot.optionalText(at: 1), seqID: try snapshot.integer(at: 2))
      guard Self.validListCursor(cursor) else { throw ChatCacheError.corrupt }

      let query = try database.prepare("SELECT id, seq_id, data FROM thread_events ORDER BY seq_id")
      var events: [ChatCacheEvent] = []
      var previous = cursor.seqID
      while try query.step() {
        let event = try query.event()
        guard event.seqID > previous else { throw ChatCacheError.corrupt }
        events.append(event)
        previous = event.seqID
      }
      return CachedThreadList(
        snapshot: try snapshot.blob(at: 0), snapshotCursor: cursor, events: events)
    }
  }

  func replaceThreadList(
    snapshot: Data, cursor: ChatCacheCursor, events: [ChatCacheEvent]
  ) throws {
    guard Self.validListCursor(cursor) else { throw ChatCacheError.invalidCursor }
    try Self.validate(events, after: cursor.seqID)
    try withDatabase { database in
      try database.transaction {
        try database.execute("DELETE FROM thread_events")
        try database.execute("DELETE FROM thread_list")
        let insert = try database.prepare(
          "INSERT INTO thread_list (id, snapshot, snapshot_event_id, snapshot_seq_id) VALUES (1, ?, ?, ?)"
        )
        try insert.bind(snapshot, at: 1)
        try insert.bind(cursor.eventID, at: 2)
        try insert.bind(cursor.seqID, at: 3)
        try insert.run()
        for event in events { try Self.insert(event, into: "thread_events", database: database) }
      }
    }
  }

  func appendThreadEvents(_ events: [ChatCacheEvent]) throws {
    guard !events.isEmpty else { return }
    try Self.validate(events, after: 0)
    try withDatabase { database in
      try database.transaction {
        let base = try database.prepare("SELECT snapshot_seq_id FROM thread_list WHERE id = 1")
        guard try base.step() else { throw ChatCacheError.missingThreadList }
        let snapshotSeqID = try base.integer(at: 0)
        let latest = try database.prepare("SELECT MAX(seq_id) FROM thread_events")
        _ = try latest.step()
        var previous = max(snapshotSeqID, try latest.optionalInteger(at: 0) ?? snapshotSeqID)
        for event in events {
          if event.seqID <= previous {
            guard
              try Self.existingEvent(id: event.id, in: "thread_events", database: database)
                == event
            else { throw ChatCacheError.invalidEventSequence }
          } else {
            try Self.insert(event, into: "thread_events", database: database)
            previous = event.seqID
          }
        }
      }
    }
  }

  func loadHistory(threadID: String) throws -> CachedChatHistory? {
    try withDatabase { database in
      let history = try database.prepare(
        "SELECT cursor_event_id, cursor_seq_id, schema_version FROM histories WHERE thread_id = ?")
      try history.bind(threadID, at: 1)
      guard try history.step() else { return nil }
      let cursor = ChatCacheCursor(
        eventID: history.optionalText(at: 0), seqID: try history.integer(at: 1))
      let schemaVersion = try history.integer(at: 2)
      guard Self.validHistoryCursor(cursor), schemaVersion > 0 else {
        throw ChatCacheError.corrupt
      }

      let query = try database.prepare(
        "SELECT id, seq_id, data FROM history_rows WHERE thread_id = ? ORDER BY seq_id")
      try query.bind(threadID, at: 1)
      var rows: [ChatCacheEvent] = []
      var previous = 0
      while try query.step() {
        let row = try query.event()
        guard row.seqID > previous, row.seqID <= cursor.seqID else {
          throw ChatCacheError.corrupt
        }
        rows.append(row)
        previous = row.seqID
      }
      guard
        (rows.last.map { ChatCacheCursor(eventID: $0.id, seqID: $0.seqID) }
          ?? ChatCacheCursor(eventID: nil, seqID: 0)) == cursor
      else { throw ChatCacheError.corrupt }
      return CachedChatHistory(rows: rows, cursor: cursor, schemaVersion: schemaVersion)
    }
  }

  func replaceHistory(
    threadID: String, rows: [ChatCacheEvent], cursor: ChatCacheCursor, schemaVersion: Int
  ) throws {
    try Self.validateHistory(rows: rows, cursor: cursor, schemaVersion: schemaVersion)
    try withDatabase { database in
      try database.transaction {
        let delete = try database.prepare("DELETE FROM histories WHERE thread_id = ?")
        try delete.bind(threadID, at: 1)
        try delete.run()
        let insert = try database.prepare(
          "INSERT INTO histories (thread_id, cursor_event_id, cursor_seq_id, schema_version) VALUES (?, ?, ?, ?)"
        )
        try insert.bind(threadID, at: 1)
        try insert.bind(cursor.eventID, at: 2)
        try insert.bind(cursor.seqID, at: 3)
        try insert.bind(schemaVersion, at: 4)
        try insert.run()
        for row in rows {
          try Self.insert(row, into: "history_rows", threadID: threadID, database: database)
        }
      }
    }
  }

  func appendHistory(
    threadID: String, rows: [ChatCacheEvent], cursor: ChatCacheCursor, schemaVersion: Int
  ) throws {
    try Self.validateHistory(
      rows: rows, cursor: cursor, schemaVersion: schemaVersion, allowEmptyPage: true)
    try withDatabase { database in
      try database.transaction {
        let current = try database.prepare(
          "SELECT cursor_event_id, cursor_seq_id, schema_version FROM histories WHERE thread_id = ?"
        )
        try current.bind(threadID, at: 1)
        guard try current.step() else { throw ChatCacheError.missingHistory }
        let previousCursor = ChatCacheCursor(
          eventID: current.optionalText(at: 0), seqID: try current.integer(at: 1))
        guard try current.integer(at: 2) == schemaVersion else {
          throw ChatCacheError.incompatibleHistorySchema
        }
        var previous = previousCursor.seqID
        for row in rows {
          if row.seqID <= previous {
            guard
              try Self.existingEvent(
                id: row.id, in: "history_rows", threadID: threadID, database: database) == row
            else { throw ChatCacheError.invalidEventSequence }
          } else {
            try Self.insert(row, into: "history_rows", threadID: threadID, database: database)
            previous = row.seqID
          }
        }
        guard cursor.seqID >= previousCursor.seqID,
          rows.isEmpty ? cursor == previousCursor : cursor.seqID == previous
        else { throw ChatCacheError.invalidCursor }
        let update = try database.prepare(
          "UPDATE histories SET cursor_event_id = ?, cursor_seq_id = ? WHERE thread_id = ?")
        try update.bind(cursor.eventID, at: 1)
        try update.bind(cursor.seqID, at: 2)
        try update.bind(threadID, at: 3)
        try update.run()
      }
    }
  }

  func deleteHistory(threadID: String) throws {
    try withDatabase { database in
      let delete = try database.prepare("DELETE FROM histories WHERE thread_id = ?")
      try delete.bind(threadID, at: 1)
      try delete.run()
    }
  }

  private func withDatabase<Result>(_ body: (CacheDatabase) throws -> Result) throws -> Result {
    do {
      return try body(database())
    } catch let error as CacheSQLiteError where error.isCorrupt {
      try reset()
      return try body(database())
    } catch ChatCacheError.corrupt {
      try reset()
      return try body(database())
    } catch ChatCacheError.unsupportedVersion {
      try reset()
      return try body(database())
    }
  }

  private func database() throws -> CacheDatabase {
    if let connection { return connection }
    let directory = fileURL.deletingLastPathComponent()
    try FileManager.default.createDirectory(
      at: directory, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.complete])
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    var mutableDirectory = directory
    try mutableDirectory.setResourceValues(values)
    let opened = try CacheDatabase(url: fileURL)
    try opened.initialize(version: Self.version)
    connection = opened
    return opened
  }

  private func reset() throws {
    connection = nil
    for suffix in ["", "-wal", "-shm"] {
      let path = URL(fileURLWithPath: fileURL.path + suffix)
      if FileManager.default.fileExists(atPath: path.path) {
        try FileManager.default.removeItem(at: path)
      }
    }
  }

  private static func validListCursor(_ cursor: ChatCacheCursor) -> Bool {
    if cursor.seqID == 0 { return cursor.eventID == nil }
    return cursor.seqID > 0 && (cursor.eventID == nil || cursor.eventID?.isEmpty == false)
  }

  private static func validHistoryCursor(_ cursor: ChatCacheCursor) -> Bool {
    cursor.seqID == 0 ? cursor.eventID == nil : cursor.seqID > 0 && cursor.eventID?.isEmpty == false
  }

  private static func validate(_ events: [ChatCacheEvent], after: Int) throws {
    var previous = after
    var ids = Set<String>()
    for event in events {
      guard !event.id.isEmpty, event.seqID > previous, ids.insert(event.id).inserted else {
        throw ChatCacheError.invalidEventSequence
      }
      previous = event.seqID
    }
  }

  private static func validateHistory(
    rows: [ChatCacheEvent], cursor: ChatCacheCursor, schemaVersion: Int,
    allowEmptyPage: Bool = false
  ) throws {
    guard validHistoryCursor(cursor), schemaVersion > 0 else {
      throw ChatCacheError.invalidCursor
    }
    try validate(rows, after: 0)
    if rows.isEmpty && allowEmptyPage { return }
    guard
      (rows.last.map { ChatCacheCursor(eventID: $0.id, seqID: $0.seqID) }
        ?? ChatCacheCursor(eventID: nil, seqID: 0)) == cursor
    else { throw ChatCacheError.invalidCursor }
  }

  private static func insert(
    _ event: ChatCacheEvent, into table: String, threadID: String? = nil,
    database: CacheDatabase
  ) throws {
    let statement: CacheStatement
    if let threadID {
      statement = try database.prepare(
        "INSERT INTO history_rows (thread_id, id, seq_id, data) VALUES (?, ?, ?, ?)")
      try statement.bind(threadID, at: 1)
      try statement.bind(event.id, at: 2)
      try statement.bind(event.seqID, at: 3)
      try statement.bind(event.data, at: 4)
    } else {
      precondition(table == "thread_events")
      statement = try database.prepare(
        "INSERT INTO thread_events (id, seq_id, data) VALUES (?, ?, ?)")
      try statement.bind(event.id, at: 1)
      try statement.bind(event.seqID, at: 2)
      try statement.bind(event.data, at: 3)
    }
    try statement.run()
  }

  private static func existingEvent(
    id: String, in table: String, threadID: String? = nil, database: CacheDatabase
  ) throws -> ChatCacheEvent? {
    let statement: CacheStatement
    if let threadID {
      statement = try database.prepare(
        "SELECT id, seq_id, data FROM history_rows WHERE thread_id = ? AND id = ?")
      try statement.bind(threadID, at: 1)
      try statement.bind(id, at: 2)
    } else {
      precondition(table == "thread_events")
      statement = try database.prepare("SELECT id, seq_id, data FROM thread_events WHERE id = ?")
      try statement.bind(id, at: 1)
    }
    return try statement.step() ? statement.event() : nil
  }
}

private struct CacheSQLiteError: Error {
  let code: Int32
  let message: String

  var isCorrupt: Bool {
    let primaryCode = code & 0xff
    return primaryCode == SQLITE_CORRUPT || primaryCode == SQLITE_NOTADB
  }
}

private final class CacheDatabase {
  private let handle: OpaquePointer

  init(url: URL) throws {
    var opened: OpaquePointer?
    let result = sqlite3_open_v2(
      url.path, &opened, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil)
    guard result == SQLITE_OK, let opened else {
      let message =
        opened.map { String(cString: sqlite3_errmsg($0)) } ?? "Unable to open chat cache"
      if let opened { sqlite3_close(opened) }
      throw CacheSQLiteError(code: result, message: message)
    }
    handle = opened
    sqlite3_busy_timeout(handle, 5_000)
  }

  deinit { sqlite3_close(handle) }

  func initialize(version: Int) throws {
    try execute("PRAGMA journal_mode = WAL")
    try execute("PRAGMA foreign_keys = ON")
    let currentVersion: Int
    do {
      let check = try prepare("PRAGMA quick_check")
      guard try check.step(), check.optionalText(at: 0) == "ok" else {
        throw ChatCacheError.corrupt
      }
      let query = try prepare("PRAGMA user_version")
      guard try query.step() else { throw ChatCacheError.corrupt }
      currentVersion = try query.integer(at: 0)
    }
    guard currentVersion == 0 || currentVersion == version else {
      throw ChatCacheError.unsupportedVersion
    }
    if currentVersion == version { return }
    try transaction {
      try execute(
        """
        CREATE TABLE IF NOT EXISTS thread_list (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          snapshot BLOB NOT NULL,
          snapshot_event_id TEXT,
          snapshot_seq_id INTEGER NOT NULL CHECK (snapshot_seq_id >= 0)
        )
        """)
      try execute(
        """
        CREATE TABLE IF NOT EXISTS thread_events (
          id TEXT PRIMARY KEY,
          seq_id INTEGER NOT NULL UNIQUE CHECK (seq_id > 0),
          data BLOB NOT NULL
        )
        """)
      try execute(
        """
        CREATE TABLE IF NOT EXISTS histories (
          thread_id TEXT PRIMARY KEY,
          cursor_event_id TEXT,
          cursor_seq_id INTEGER NOT NULL CHECK (cursor_seq_id >= 0),
          schema_version INTEGER NOT NULL CHECK (schema_version > 0)
        )
        """)
      try execute(
        """
        CREATE TABLE IF NOT EXISTS history_rows (
          thread_id TEXT NOT NULL REFERENCES histories(thread_id) ON DELETE CASCADE,
          id TEXT NOT NULL,
          seq_id INTEGER NOT NULL CHECK (seq_id > 0),
          data BLOB NOT NULL,
          PRIMARY KEY (thread_id, id),
          UNIQUE (thread_id, seq_id)
        )
        """)
      try execute("PRAGMA user_version = \(version)")
    }
  }

  func transaction<Result>(_ body: () throws -> Result) throws -> Result {
    try execute("BEGIN IMMEDIATE")
    do {
      let result = try body()
      try execute("COMMIT")
      return result
    } catch {
      try? execute("ROLLBACK")
      throw error
    }
  }

  func execute(_ sql: String) throws {
    let result = sqlite3_exec(handle, sql, nil, nil, nil)
    guard result == SQLITE_OK else { throw failure(code: result) }
  }

  func prepare(_ sql: String) throws -> CacheStatement {
    var statement: OpaquePointer?
    let result = sqlite3_prepare_v2(handle, sql, -1, &statement, nil)
    guard result == SQLITE_OK, let statement else { throw failure(code: result) }
    return CacheStatement(database: self, handle: statement)
  }

  func failure(code: Int32? = nil) -> CacheSQLiteError {
    CacheSQLiteError(
      code: code ?? sqlite3_extended_errcode(handle),
      message: String(cString: sqlite3_errmsg(handle)))
  }
}

private final class CacheStatement {
  private let database: CacheDatabase
  private let handle: OpaquePointer

  init(database: CacheDatabase, handle: OpaquePointer) {
    self.database = database
    self.handle = handle
  }

  deinit { sqlite3_finalize(handle) }

  func bind(_ value: String?, at index: Int32) throws {
    guard let value else {
      try bindNull(at: index)
      return
    }
    let result = value.withCString { pointer in
      sqlite3_bind_text(handle, index, pointer, -1, cacheSQLiteTransient)
    }
    guard result == SQLITE_OK else { throw database.failure(code: result) }
  }

  func bind(_ value: Int, at index: Int32) throws {
    let result = sqlite3_bind_int64(handle, index, Int64(value))
    guard result == SQLITE_OK else { throw database.failure(code: result) }
  }

  func bind(_ value: Data, at index: Int32) throws {
    let result: Int32
    if value.isEmpty {
      result = sqlite3_bind_zeroblob(handle, index, 0)
    } else {
      result = value.withUnsafeBytes { bytes in
        sqlite3_bind_blob(
          handle, index, bytes.baseAddress, Int32(bytes.count), cacheSQLiteTransient)
      }
    }
    guard result == SQLITE_OK else { throw database.failure(code: result) }
  }

  private func bindNull(at index: Int32) throws {
    let result = sqlite3_bind_null(handle, index)
    guard result == SQLITE_OK else { throw database.failure(code: result) }
  }

  func step() throws -> Bool {
    let result = sqlite3_step(handle)
    switch result {
    case SQLITE_ROW: return true
    case SQLITE_DONE: return false
    default: throw database.failure(code: result)
    }
  }

  func run() throws {
    guard try !step() else { throw ChatCacheError.corrupt }
  }

  func integer(at index: Int32) throws -> Int {
    guard sqlite3_column_type(handle, index) == SQLITE_INTEGER,
      let value = Int(exactly: sqlite3_column_int64(handle, index))
    else { throw ChatCacheError.corrupt }
    return value
  }

  func optionalInteger(at index: Int32) throws -> Int? {
    sqlite3_column_type(handle, index) == SQLITE_NULL ? nil : try integer(at: index)
  }

  func optionalText(at index: Int32) -> String? {
    guard let pointer = sqlite3_column_text(handle, index) else { return nil }
    return String(cString: pointer)
  }

  func blob(at index: Int32) throws -> Data {
    guard sqlite3_column_type(handle, index) == SQLITE_BLOB else {
      throw ChatCacheError.corrupt
    }
    let length = Int(sqlite3_column_bytes(handle, index))
    if length == 0 { return Data() }
    guard let bytes = sqlite3_column_blob(handle, index) else { throw ChatCacheError.corrupt }
    return Data(bytes: bytes, count: length)
  }

  func event() throws -> ChatCacheEvent {
    guard let id = optionalText(at: 0), !id.isEmpty else { throw ChatCacheError.corrupt }
    return ChatCacheEvent(id: id, seqID: try integer(at: 1), data: try blob(at: 2))
  }
}

private let cacheSQLiteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
