import Foundation
import SQLite3

/// Owned defaults and real filesystem/SQLite boundaries for preference persistence tests.
@MainActor
public final class PreferenceStorageFixture {
  public let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
  public let suiteName: String
  public let defaults: UserDefaults

  public init() throws {
    let suiteName = "project-disclosure-" + UUID().uuidString
    guard let defaults = UserDefaults(suiteName: suiteName) else {
      throw CocoaError(.fileWriteUnknown)
    }
    self.defaults = defaults
    self.suiteName = suiteName
  }

  public func close() throws {
    defaults.removePersistentDomain(forName: suiteName)
    if FileManager.default.fileExists(atPath: directory.path) {
      try FileManager.default.removeItem(at: directory)
    }
  }

  public func legacyKey(apiURL: URL, userID: String, workspaceID: String) -> String {
    "project-expansion:\(apiURL.absoluteString):\(userID):\(workspaceID)"
  }

  public func databaseURL() throws -> URL {
    let files = try FileManager.default.contentsOfDirectory(
      at: directory.appending(path: "ProjectDisclosure"), includingPropertiesForKeys: nil
    )
    .filter { $0.pathExtension == "sqlite" }
    guard files.count == 1, let file = files.first else { throw CocoaError(.fileReadUnknown) }
    return file
  }

  public func execute(_ sql: String) throws {
    try withDatabase { try execute(sql, in: $0) }
  }

  public func integer(_ sql: String) throws -> Int {
    try withDatabase { database in
      var prepared: OpaquePointer?
      guard sqlite3_prepare_v2(database, sql, -1, &prepared, nil) == SQLITE_OK,
        let prepared
      else { throw CocoaError(.fileReadUnknown) }
      defer { sqlite3_finalize(prepared) }
      guard sqlite3_step(prepared) == SQLITE_ROW else { throw CocoaError(.fileReadUnknown) }
      return Int(sqlite3_column_int64(prepared, 0))
    }
  }

  /// A real competing SQLite writer fences the disk read without timing guesses.
  public func holdingWriteLock(_ body: () throws -> Void) throws {
    try withDatabase { database in
      try execute("BEGIN IMMEDIATE", in: database)
      do {
        try body()
        try execute("COMMIT", in: database)
      } catch {
        try? execute("ROLLBACK", in: database)
        throw error
      }
    }
  }

  private func withDatabase<Value>(_ body: (OpaquePointer) throws -> Value) throws -> Value {
    var opened: OpaquePointer?
    let result = sqlite3_open_v2(
      try databaseURL().path, &opened, SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil)
    guard result == SQLITE_OK, let opened else {
      if let opened { sqlite3_close(opened) }
      throw CocoaError(.fileReadUnknown)
    }
    defer { sqlite3_close(opened) }
    return try body(opened)
  }

  private func execute(_ sql: String, in database: OpaquePointer) throws {
    guard sqlite3_exec(database, sql, nil, nil, nil) == SQLITE_OK else {
      throw CocoaError(.fileWriteUnknown)
    }
  }
}
