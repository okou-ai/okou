import ChatDomain
import Foundation

/// A progressively expanded suffix of presentation groups, independent of event replay.
struct ConversationRenderWindow {
  private static let groupCount = 10
  // The last input applied to native coordinates, not a second reactive projection.
  private var appliedItems: [ConversationItem] = []
  private var ids: [String] { appliedItems.map(\.id) }
  private var groupStarts: [Int] = []
  private var followsLatest = true
  private(set) var range = 0..<0

  var hasEarlierMessages: Bool { range.lowerBound > 0 }

  @discardableResult
  mutating func update(_ items: [ConversationItem], preservingBoundary: Bool) -> Bool {
    guard appliedItems != items else { return false }
    let newIDs = items.map(\.id)
    let oldBoundary = range.lowerBound
    var boundary: Int?
    if !followsLatest || preservingBoundary {
      let indexes = Dictionary(uniqueKeysWithValues: newIDs.enumerated().map { ($1, $0) })
      // A revoked boundary advances to the next surviving row in the previously visible suffix.
      boundary = ids.dropFirst(oldBoundary).lazy.compactMap { indexes[$0] }.first
    }
    appliedItems = items
    groupStarts = items.indices.filter { index in
      index == 0 || items[index].beginsWorkSection || items[index].role != items[index - 1].role
    }
    let start: Int
    if let boundary {
      start = groupStarts.last(where: { $0 <= boundary }) ?? 0
    } else {
      start = latestStart
    }
    range = start..<items.count
    return true
  }

  /// Rebase a revoked native anchor using the previously applied row order.
  func rebased(
    _ position: ConversationReadingPosition?, to items: [ConversationItem]
  ) -> ConversationReadingPosition? {
    guard let position else { return nil }
    let surviving = Set(items.map(\.id))
    guard !surviving.contains(position.messageID) else { return position }
    guard let index = ids.firstIndex(of: position.messageID),
      let replacement = ids.dropFirst(index + 1).first(where: { surviving.contains($0) })
        ?? ids.prefix(index).last(where: { surviving.contains($0) })
    else { return nil }
    return ConversationReadingPosition(messageID: replacement, offset: position.offset)
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
