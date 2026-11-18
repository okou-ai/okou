import ChatData
import ChatDomain
import Foundation

enum ThreadListReadProjection {
  static func restoring(
    _ snapshot: [ChatThread], preserving current: [ChatThread]
  ) -> [ChatThread] {
    let previous = Dictionary(uniqueKeysWithValues: current.map { ($0.id, $0) })
    return snapshot.map { thread in
      var updated = thread
      updated.indicator = previous[thread.id]?.indicator
      updated.unreadAt = previous[thread.id]?.unreadAt
      return updated
    }
  }

  static func readState(_ snapshot: [ChatThread], unreadAt: [String: Date]) -> [ChatThread] {
    snapshot.map { thread in
      var updated = thread
      updated.unreadAt = thread.isMuted ? nil : unreadAt[thread.id]
      if updated.unreadAt != nil {
        updated.indicator = .unread
      } else if updated.indicator == .unread {
        updated.indicator = nil
      }
      return updated
    }
  }
}
