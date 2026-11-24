extension SQLiteDatabase {
  func absentThreadIDs(confirmed: Bool) throws -> Set<String> {
    let rows = try prepare("SELECT thread_id FROM thread_absences WHERE confirmed = ?")
    try rows.bind(confirmed ? 1 : 0, at: 1)
    var ids = Set<String>()
    while try rows.step() {
      if let id = rows.optionalText(at: 0) { ids.insert(id) }
    }
    return ids
  }

  /// A later snapshot omission cannot downgrade a confirmed deletion.
  func recordThreadAbsence(_ id: String, confirmed: Bool) throws {
    let row = try prepare(
      """
      INSERT INTO thread_absences (thread_id, confirmed) VALUES (?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET confirmed = MAX(confirmed, excluded.confirmed)
      """)
    try row.bind(id, at: 1)
    try row.bind(confirmed ? 1 : 0, at: 2)
    try row.run()
  }

  func forgetThreadAbsences(_ ids: Set<String>, confirmed: Bool) throws {
    for id in ids {
      let row = try prepare("DELETE FROM thread_absences WHERE thread_id = ? AND confirmed = ?")
      try row.bind(id, at: 1)
      try row.bind(confirmed ? 1 : 0, at: 2)
      try row.run()
    }
  }
}
