import Foundation

/// Validates persisted event/cursor contracts without owning a database connection.
enum ChatCacheValidation {

  static func validListCursor(_ cursor: ChatCacheCursor) -> Bool {
    if cursor.seqID == 0 { return cursor.eventID == nil }
    return cursor.seqID > 0 && (cursor.eventID == nil || cursor.eventID?.isEmpty == false)
  }

  static func validHistoryCursor(_ cursor: ChatCacheCursor) -> Bool {
    cursor.seqID == 0 ? cursor.eventID == nil : cursor.seqID > 0 && cursor.eventID?.isEmpty == false
  }

  static func validate(_ events: [ChatCacheEvent], after: Int) throws {
    var previous = after
    var ids = Set<String>()
    for event in events {
      guard !event.id.isEmpty, event.seqID > previous, ids.insert(event.id).inserted else {
        throw ChatCacheError.invalidEventSequence
      }
      previous = event.seqID
    }
  }

  static func validateHistory(
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
}
