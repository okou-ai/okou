import CryptoKit
import Foundation
import OSLog
import SQLite3

public struct ChatCacheScope: Sendable {
  public let apiBaseURL: URL
  public let userID: String
  public let workspaceID: String

  public init(
    apiBaseURL: URL,
    userID: String,
    workspaceID: String
  ) {
    self.apiBaseURL = apiBaseURL
    self.userID = userID
    self.workspaceID = workspaceID
  }
}

public struct ChatCacheCursor: Equatable, Sendable {
  public let eventID: String?
  public let seqID: Int

  public init(
    eventID: String?,
    seqID: Int
  ) {
    self.eventID = eventID
    self.seqID = seqID
  }
}

public struct ChatCacheEvent: Equatable, Sendable {
  public let id: String
  public let seqID: Int
  public let data: Data

  public init(
    id: String,
    seqID: Int,
    data: Data
  ) {
    self.id = id
    self.seqID = seqID
    self.data = data
  }
}

public struct CachedThreadList: Sendable {
  public let snapshot: Data
  public let snapshotCursor: ChatCacheCursor
  public let events: [ChatCacheEvent]

  public init(
    snapshot: Data,
    snapshotCursor: ChatCacheCursor,
    events: [ChatCacheEvent]
  ) {
    self.snapshot = snapshot
    self.snapshotCursor = snapshotCursor
    self.events = events
  }
}

public struct CachedChatHistory: Sendable {
  public let rows: [ChatCacheEvent]
  public let cursor: ChatCacheCursor
  public let schemaVersion: Int

  public init(
    rows: [ChatCacheEvent],
    cursor: ChatCacheCursor,
    schemaVersion: Int
  ) {
    self.rows = rows
    self.cursor = cursor
    self.schemaVersion = schemaVersion
  }
}

public enum ChatCacheError: Error {
  case unavailable
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
public actor ChatCache {
  private static let version = 1

  private let fileURL: URL
  private let legacyFileURL: URL?
  private var connection: CacheDatabase?
  private var isClosed = false

  public init(
    scope: ChatCacheScope, directory: URL? = nil, migratingFrom legacyDirectory: URL? = nil
  ) {
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
    legacyFileURL = legacyDirectory?.appendingPathComponent("ChatCache", isDirectory: true)
      .appendingPathComponent(filename)
  }

  /// NSE completion is durable before the alert is released; foreground owns upload.
  public func savePrefetchReport(_ report: NotificationPrefetchReport) throws {
    let encoded = try JSONEncoder().encode(report)
    try withDatabase { database in
      try database.transaction {
        let insert = try database.prepare(
          "INSERT INTO notification_prefetch_reports (report) VALUES (?)")
        try insert.bind(encoded, at: 1)
        try insert.run()
        try database.execute(
          "DELETE FROM notification_prefetch_reports WHERE id NOT IN (SELECT id FROM notification_prefetch_reports ORDER BY id DESC LIMIT 100)"
        )
      }
    }
  }

  public func prefetchReports() throws -> [(id: Int, report: NotificationPrefetchReport)] {
    try withDatabase { database in
      let query = try database.prepare(
        "SELECT id, report FROM notification_prefetch_reports ORDER BY id")
      var reports: [(id: Int, report: NotificationPrefetchReport)] = []
      while try query.step() {
        reports.append(
          (
            try query.integer(at: 0),
            try JSONDecoder().decode(
              NotificationPrefetchReport.self, from: query.blob(at: 1))
          ))
      }
      return reports
    }
  }

  public func acknowledgePrefetchReport(_ id: Int) throws {
    try withDatabase { database in
      let delete = try database.prepare("DELETE FROM notification_prefetch_reports WHERE id = ?")
      try delete.bind(id, at: 1)
      try delete.run()
    }
  }

  /// Retire this connection even when a completed task still retains its owner.
  /// Later work must create a new scoped cache instead of reopening a retired one.
  public func close() {
    isClosed = true
    connection = nil
  }

  public func loadNavigation() throws -> SidebarNavigationSnapshot? {
    try withDatabase { database in
      let query = try database.prepare("SELECT snapshot FROM sidebar_navigation WHERE id = 1")
      guard try query.step() else { return nil }
      return try JSONDecoder().decode(SidebarNavigationSnapshot.self, from: query.blob(at: 0))
    }
  }

  public func saveNavigation(_ snapshot: SidebarNavigationSnapshot) throws {
    let data = try JSONEncoder().encode(snapshot)
    try withDatabase { database in
      let write = try database.prepare(
        "INSERT OR REPLACE INTO sidebar_navigation (id, snapshot) VALUES (1, ?)")
      try write.bind(data, at: 1)
      try write.run()
    }
  }

  public func loadThreadList() throws -> CachedThreadList? {
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

  public func replaceThreadList(
    snapshot: Data, cursor: ChatCacheCursor, events: [ChatCacheEvent]
  ) throws {
    guard Self.validListCursor(cursor) else { throw ChatCacheError.invalidCursor }
    try Self.validate(events, after: cursor.seqID)
    try withDatabase { database in
      try database.transaction {
        // Another process may have committed a newer snapshot/tail while this
        // request was in flight. Never replace that committed state with an older one.
        let latest = try database.prepare(
          "SELECT MAX(seq_id) FROM (SELECT snapshot_seq_id AS seq_id FROM thread_list UNION ALL SELECT seq_id FROM thread_events)"
        )
        _ = try latest.step()
        if let current = try latest.optionalInteger(at: 0),
          current > (events.last?.seqID ?? cursor.seqID)
        {
          return
        }
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

  public func appendThreadEvents(_ events: [ChatCacheEvent]) throws {
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
          // A newer snapshot already includes events from an older in-flight page.
          if event.seqID <= snapshotSeqID { continue }
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

  /// Warming needs only the durable cursor, not a replay of every cached message.
  public func loadHistoryCursor(threadID: String, schemaVersion: Int) throws -> ChatCacheCursor? {
    try withDatabase { database in
      let query = try database.prepare(
        "SELECT cursor_event_id, cursor_seq_id FROM histories WHERE thread_id = ? AND schema_version = ?"
      )
      try query.bind(threadID, at: 1)
      try query.bind(schemaVersion, at: 2)
      guard try query.step() else { return nil }
      let cursor = ChatCacheCursor(
        eventID: query.optionalText(at: 0), seqID: try query.integer(at: 1))
      guard Self.validHistoryCursor(cursor) else { throw ChatCacheError.corrupt }
      return cursor
    }
  }

  /// Inspect a terminal marker without loading an entire conversation into the NSE.
  public func containsRun(threadID: String, runID: String) throws -> Bool {
    try withDatabase { database in
      let query = try database.prepare(
        """
        SELECT 1 FROM history_rows WHERE thread_id = ?
          AND json_extract(CAST(data AS TEXT), '$.runId') = ?
          AND json_extract(CAST(data AS TEXT), '$.eventType') IN ('run.completed', 'run.failed', 'run.cancelled')
        LIMIT 1
        """)
      try query.bind(threadID, at: 1)
      try query.bind(runID, at: 2)
      return try query.step()
    }
  }

  public func loadHistory(threadID: String) throws -> CachedChatHistory? {
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

  public func replaceHistory(
    threadID: String, rows: [ChatCacheEvent], cursor: ChatCacheCursor, schemaVersion: Int
  ) throws {
    try Self.validateHistory(rows: rows, cursor: cursor, schemaVersion: schemaVersion)
    try withDatabase { database in
      try database.transaction {
        let existing = try database.prepare(
          "SELECT cursor_seq_id, schema_version FROM histories WHERE thread_id = ?")
        try existing.bind(threadID, at: 1)
        if try existing.step() {
          let schema = try existing.integer(at: 1)
          guard schema <= schemaVersion else { throw ChatCacheError.incompatibleHistorySchema }
          if schema == schemaVersion, try existing.integer(at: 0) > cursor.seqID { return }
        }
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

  public func appendHistory(
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
        // An overlapping app/extension page can already be present. Preserve
        // the newer durable cursor after validating every replayed row above.
        if cursor.seqID < previousCursor.seqID { return }
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

  public func deleteHistory(threadID: String) throws {
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
    guard !isClosed else { throw ChatCacheError.unavailable }
    if let connection { return connection }
    let directory = fileURL.deletingLastPathComponent()
    try FileManager.default.createDirectory(
      at: directory, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    let protection: [FileAttributeKey: Any] = [
      .protectionKey: FileProtectionType.completeUntilFirstUserAuthentication
    ]
    try FileManager.default.setAttributes(protection, ofItemAtPath: directory.path)
    for suffix in ["", "-wal", "-shm"] {
      let path = fileURL.path + suffix
      if FileManager.default.fileExists(atPath: path) {
        try FileManager.default.setAttributes(protection, ofItemAtPath: path)
      }
    }
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    var mutableDirectory = directory
    try mutableDirectory.setResourceValues(values)
    let opened = try CacheDatabase(url: fileURL)
    try opened.initialize(version: Self.version)
    if let legacyFileURL, legacyFileURL != fileURL {
      do {
        try opened.importLegacy(from: legacyFileURL)
      } catch {
        // A damaged old cache must not reset a newer store created by the NSE.
        Logger(subsystem: "ai.okou.ios", category: "ChatCache")
          .error("Cannot import previous cache: \(error.localizedDescription, privacy: .public)")
      }
    }
    for suffix in ["", "-wal", "-shm"] {
      let path = fileURL.path + suffix
      if FileManager.default.fileExists(atPath: path) {
        try FileManager.default.setAttributes(protection, ofItemAtPath: path)
      }
    }
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
    try execute("CREATE TABLE IF NOT EXISTS cache_migrations (id INTEGER PRIMARY KEY)")
    try execute(
      "CREATE TABLE IF NOT EXISTS notification_prefetch_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, report BLOB NOT NULL)"
    )
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
    // This additive table also works with caches written by the preceding build;
    // earlier readers keep using the unchanged thread and history tables.
    try execute(
      """
      CREATE TABLE IF NOT EXISTS sidebar_navigation (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        snapshot BLOB NOT NULL
      )
      """)
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

  /// The extension can create the shared store before the first app launch.
  /// Merge the old app-private cache once, preserving newer shared cursors.
  func importLegacy(from url: URL) throws {
    let imported: Bool = try {
      let check = try prepare("SELECT 1 FROM cache_migrations WHERE id = 1")
      return try check.step()
    }()
    guard !imported else { return }
    guard FileManager.default.fileExists(atPath: url.path) else {
      try execute("INSERT OR IGNORE INTO cache_migrations (id) VALUES (1)")
      return
    }
    do {
      let attach = try prepare("ATTACH DATABASE ? AS legacy")
      try attach.bind(url.path, at: 1)
      try attach.run()
    }
    defer { try? execute("DETACH DATABASE legacy") }
    try transaction {
      let legacyVersion: Int = try {
        let query = try prepare("PRAGMA legacy.user_version")
        guard try query.step() else { throw ChatCacheError.unsupportedVersion }
        return try query.integer(at: 0)
      }()
      guard legacyVersion == 1 else { throw ChatCacheError.unsupportedVersion }
      let hasNavigation: Bool = try {
        let query = try prepare(
          "SELECT 1 FROM legacy.sqlite_master WHERE name = 'sidebar_navigation'")
        return try query.step()
      }()
      if hasNavigation {
        try execute(
          "INSERT OR IGNORE INTO sidebar_navigation SELECT * FROM legacy.sidebar_navigation")
      }
      func listCursor(_ prefix: String) throws -> Int? {
        let query = try prepare(
          "SELECT MAX(seq_id) FROM (SELECT snapshot_seq_id AS seq_id FROM \(prefix)thread_list UNION ALL SELECT seq_id FROM \(prefix)thread_events)"
        )
        _ = try query.step()
        return try query.optionalInteger(at: 0)
      }
      if let old = try listCursor("legacy."), old > (try listCursor("") ?? -1) {
        try execute("DELETE FROM thread_events")
        try execute("DELETE FROM thread_list")
        try execute("INSERT INTO thread_list SELECT * FROM legacy.thread_list")
        try execute("INSERT INTO thread_events SELECT * FROM legacy.thread_events")
      }
      let histories: [(String, Int, Int)] = try {
        let query = try prepare(
          "SELECT thread_id, cursor_seq_id, schema_version FROM legacy.histories")
        var rows: [(String, Int, Int)] = []
        while try query.step() {
          guard let id = query.optionalText(at: 0) else { throw ChatCacheError.corrupt }
          rows.append((id, try query.integer(at: 1), try query.integer(at: 2)))
        }
        return rows
      }()
      for (id, sequence, schema) in histories {
        let shouldCopy: Bool = try {
          let query = try prepare(
            "SELECT cursor_seq_id, schema_version FROM histories WHERE thread_id = ?")
          try query.bind(id, at: 1)
          guard try query.step() else { return true }
          let currentSchema = try query.integer(at: 1)
          let currentSequence = try query.integer(at: 0)
          return schema > currentSchema || (schema == currentSchema && sequence > currentSequence)
        }()
        guard shouldCopy else { continue }
        let delete = try prepare("DELETE FROM histories WHERE thread_id = ?")
        try delete.bind(id, at: 1)
        try delete.run()
        for table in ["histories", "history_rows"] {
          let copy = try prepare(
            "INSERT INTO \(table) SELECT * FROM legacy.\(table) WHERE thread_id = ?")
          try copy.bind(id, at: 1)
          try copy.run()
        }
      }
      try execute("INSERT OR IGNORE INTO cache_migrations (id) VALUES (1)")
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
