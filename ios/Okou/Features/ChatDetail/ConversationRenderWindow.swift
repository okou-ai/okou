import ChatDomain
import Foundation

/// A progressively expanded suffix of presentation groups, independent of event replay.
struct ConversationRenderWindow {
  private static let groupCount = 10
  private var ids: [String] = []
  private var groupStarts: [Int] = []
  private var followsLatest = true
  private(set) var range = 0..<0

  var hasEarlierMessages: Bool { range.lowerBound > 0 }

  mutating func update(_ messages: [ChatMessage]) {
    let newIDs = messages.map(\.id)
    let oldBoundary = range.lowerBound
    var boundary: Int?
    if !followsLatest {
      let indexes = Dictionary(uniqueKeysWithValues: newIDs.enumerated().map { ($1, $0) })
      // A revoked boundary advances to the next surviving row in the previously visible suffix.
      boundary = ids.dropFirst(oldBoundary).lazy.compactMap { indexes[$0] }.first
    }
    ids = newIDs
    groupStarts = messages.indices.filter { index in
      index == 0 || messages[index].role != messages[index - 1].role
    }
    let start: Int
    if let boundary {
      start = groupStarts.last(where: { $0 <= boundary }) ?? 0
    } else {
      start = latestStart
    }
    range = start..<messages.count
  }

  mutating func pauseFollowing() { followsLatest = false }
  mutating func resumeFollowing() { followsLatest = true }

  mutating func expand() {
    followsLatest = false
    guard let group = groupStarts.firstIndex(of: range.lowerBound) else { return }
    range = groupStarts[max(0, group - Self.groupCount)]..<ids.count
  }

  mutating func resetToLatest() {
    followsLatest = true
    range = latestStart..<ids.count
  }

  mutating func include(_ messageID: String) {
    guard let index = ids.firstIndex(of: messageID), index < range.lowerBound else { return }
    let start = groupStarts.last(where: { $0 <= index }) ?? 0
    range = start..<ids.count
  }

  private var latestStart: Int {
    groupStarts.isEmpty ? 0 : groupStarts[max(0, groupStarts.count - Self.groupCount)]
  }
}

/// Offset from the top of the usable native List viewport, including a partially visible row.
struct ConversationReadingPosition: Equatable {
  let messageID: String
  let offset: CGFloat
}
