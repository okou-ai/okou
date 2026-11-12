import Foundation

/// One-way import of the current scope only. Never enumerate another account's defaults.
enum ProjectDisclosureMigration {
  static func importPreferences(into database: SQLiteDatabase, key: String, suiteName: String?)
    throws
  {
    let defaults: UserDefaults
    if let suiteName {
      guard let suite = UserDefaults(suiteName: suiteName) else {
        throw ProjectDisclosureError.invalidLegacyPreferences
      }
      defaults = suite
    } else {
      defaults = .standard
    }
    let check = try database.prepare("SELECT 1 FROM disclosure_migrations WHERE id = 1")
    if try !check.step() {
      let original = defaults.object(forKey: key)
      guard original == nil || original is [String: Bool] else {
        throw ProjectDisclosureError.invalidLegacyPreferences
      }
      let values = original as? [String: Bool] ?? [:]
      try database.transaction {
        for (id, expanded) in values where expanded {
          let write = try database.prepare(
            "INSERT OR IGNORE INTO expanded_projects (project_id) VALUES (?)")
          try write.bind(id, at: 1)
          try write.run()
        }
        try database.execute("INSERT INTO disclosure_migrations (id) VALUES (1)")
      }
    }
    // A crash after SQLite commits but before defaults deletion cannot resurrect
    // stale values. The durable marker wins, including an empty collapsed set.
    defaults.removeObject(forKey: key)
  }
}
