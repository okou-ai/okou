import Foundation
import SQLite3

/// Seeds the navigation blob exactly where an existing installation left it.
public enum LegacyComposerFixture {
  public static func storeLocation(_ id: String, in root: URL) throws {
    let files = try FileManager.default.contentsOfDirectory(
      at: root.appendingPathComponent("ChatCache"), includingPropertiesForKeys: nil
    ).filter { $0.pathExtension == "sqlite" }
    guard files.count == 1, let file = files.first else { throw CocoaError(.fileReadUnknown) }
    var db: OpaquePointer?
    let status = sqlite3_open_v2(file.path, &db, SQLITE_OPEN_READWRITE, nil)
    defer { sqlite3_close(db) }
    guard status == SQLITE_OK else { throw CocoaError(.fileWriteUnknown) }
    let blob = try JSONSerialization.data(withJSONObject: [
      "agents": [["agentId": id, "isDefaultAgent": true]]
    ]).map { String(format: "%02x", $0) }.joined()
    let sql = "INSERT OR REPLACE INTO sidebar_navigation (id, snapshot) VALUES (1, X'\(blob)')"
    guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else {
      throw CocoaError(.fileWriteUnknown)
    }
  }
}
