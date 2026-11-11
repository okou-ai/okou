import CryptoKit
import Dispatch
import Foundation
import OSLog
import SQLite3

public enum ProjectDisclosureError: Error {
  case closed
  case unsupportedVersion
  case invalidLegacyPreferences
}

/// Device-owned UI preferences, separate from the disposable server-confirmed cache.
/// Mutable connection state is confined to `queue`. Submission is synchronous:
/// accepted writes, close, and a new reader run in order even across owners.
public final class ProjectDisclosureStorage: @unchecked Sendable {
  private static let queue = DispatchQueue(label: "ai.okou.project-disclosure", qos: .userInitiated)
  private let fileURL: URL
  private let legacyKey: String
  private let legacySuiteName: String?
  private var connection: SQLiteDatabase?
  private var closed = false

  public init(scope: ChatCacheScope, directory: URL? = nil, legacySuiteName: String? = nil) {
    let root =
      directory
      ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    let identity = [scope.apiBaseURL.absoluteString, scope.userID, scope.workspaceID]
      .joined(separator: "\u{0}")
    let name = SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
    fileURL = root.appending(path: "ProjectDisclosure", directoryHint: .isDirectory)
      .appending(path: name + ".sqlite")
    legacyKey =
      "project-expansion:\(scope.apiBaseURL.absoluteString):\(scope.userID):\(scope.workspaceID)"
    self.legacySuiteName = legacySuiteName
  }

  public func load() -> Task<Set<String>, Error> {
    submit { owner in
      let query = try owner.database().prepare("SELECT project_id FROM expanded_projects")
      var result = Set<String>()
      while try query.step() {
        guard let id = query.optionalText(at: 0) else {
          throw SQLiteError(code: SQLITE_CORRUPT, message: "Invalid project disclosure identifier")
        }
        result.insert(id)
      }
      return result
    }
  }

  public func setExpanded(_ expanded: Bool, projectID: String) -> Task<Void, Error> {
    submit { owner in
      let sql =
        expanded
        ? "INSERT OR IGNORE INTO expanded_projects (project_id) VALUES (?)"
        : "DELETE FROM expanded_projects WHERE project_id = ?"
      let write = try owner.database().prepare(sql)
      try write.bind(projectID, at: 1)
      try write.run()
    }
  }

  /// Only an accepted, complete authoritative list can retire unrelated projects.
  public func retainProjects(_ projectIDs: Set<String>) -> Task<Void, Error> {
    submit { owner in
      let database = try owner.database()
      try database.transaction {
        let read = try database.prepare("SELECT project_id FROM expanded_projects")
        var removed: [String] = []
        while try read.step() {
          if let id = read.optionalText(at: 0), !projectIDs.contains(id) { removed.append(id) }
        }
        for id in removed {
          let write = try database.prepare("DELETE FROM expanded_projects WHERE project_id = ?")
          try write.bind(id, at: 1)
          try write.run()
        }
      }
    }
  }

  /// The queue owns bounded shutdown after every previously accepted operation.
  /// Cancelling a UI waiter never cancels an already accepted persistence mutation.
  public func close() -> Task<Void, Never> {
    let (completion, result) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
    Self.queue.async { [self] in
      closed = true
      connection = nil
      result.yield(())
      result.finish()
    }
    return Task {
      for await _ in completion { return }
    }
  }

  private func submit<Value: Sendable>(
    _ operation: @escaping @Sendable (ProjectDisclosureStorage) throws -> Value
  ) -> Task<Value, Error> {
    // Enqueue before creating the async waiter: Task scheduling/actor priorities
    // cannot reorder accepted mutations or a reader from a replacement owner.
    let (completion, result) = AsyncStream<Result<Value, Error>>.makeStream(
      bufferingPolicy: .bufferingNewest(1))
    Self.queue.async { [self] in
      do { result.yield(.success(try operation(self))) } catch {
        Logger(subsystem: "ai.okou.ios", category: "ProjectDisclosure")
          .error(
            "Cannot persist project disclosure: \(error.localizedDescription, privacy: .public)")
        result.yield(.failure(error))
      }
      result.finish()
    }
    return Task {
      for await outcome in completion { return try outcome.get() }
      throw CancellationError()
    }
  }

  private func database() throws -> SQLiteDatabase {
    guard !closed else { throw ProjectDisclosureError.closed }
    if let connection { return connection }
    let directory = fileURL.deletingLastPathComponent()
    try FileManager.default.createDirectory(
      at: directory, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    let opened = try SQLiteDatabase(url: fileURL)
    try opened.execute("PRAGMA journal_mode = WAL")
    try opened.transaction {
      let version = try opened.prepare("PRAGMA user_version")
      guard try version.step(), [0, 1].contains(try version.integer(at: 0)) else {
        throw ProjectDisclosureError.unsupportedVersion
      }
      try opened.execute(
        "CREATE TABLE IF NOT EXISTS expanded_projects (project_id TEXT PRIMARY KEY NOT NULL)")
      try opened.execute(
        "CREATE TABLE IF NOT EXISTS disclosure_migrations (id INTEGER PRIMARY KEY)")
      try opened.execute("PRAGMA user_version = 1")
    }
    try ProjectDisclosureMigration.importPreferences(
      into: opened, key: legacyKey, suiteName: legacySuiteName)
    // Preferences retain normal Application Support backup behavior. They are
    // not a cache and must never inherit ChatCache's delete-and-rebuild recovery.
    for suffix in ["", "-wal", "-shm"] {
      let path = fileURL.path + suffix
      if FileManager.default.fileExists(atPath: path) {
        try FileManager.default.setAttributes(
          [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
          ofItemAtPath: path)
      }
    }
    connection = opened
    return opened
  }
}
