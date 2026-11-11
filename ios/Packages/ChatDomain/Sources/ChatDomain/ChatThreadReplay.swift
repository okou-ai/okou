import Foundation

/// Replays the thread snapshot and its ordered lifecycle tail. This follows
/// `replayChatThreadEvents` in the web client; display-specific pin ranking is
/// applied separately by `sidebarOrder`.
public enum ChatThreadReplay {
  public static func replay(snapshot: [ChatThread], events: [ChatThreadChange]) -> [ChatThread] {
    var threads: [String: ChatThread] = [:]
    for thread in snapshot { threads[thread.id] = thread }
    var pendingUpdates: [String: [ChatThreadChange]] = [:]

    for event in events {
      apply(event, to: &threads, pendingUpdates: &pendingUpdates)
    }
    return threads.values.filter { !$0.isHidden }.sorted(by: replayOrder)
  }

  /// Matches the web sidebar's separate `comparePinnedThreads` pass. Unpinned
  /// threads retain the reducer's activity order.
  public static func sidebarOrder(_ threads: [ChatThread]) -> [ChatThread] {
    threads.sorted { left, right in
      switch (left.pinnedAt, right.pinnedAt) {
      case (.some, .none): return true
      case (.none, .some): return false
      case (.none, .none): return replayOrder(left, right)
      case (.some, .some):
        let leftRank = pinRank(left)
        let rightRank = pinRank(right)
        if leftRank != rightRank { return leftRank < rightRank }
        return left.id > right.id
      }
    }
  }

  /// fractional-indexing's generateKeyBetween(null, first), as the PWA prepends a new pin.
  /// Keep the base-62 keys compatible with the PWA and the existing pin API.
  public static func firstPinOrder(_ threads: [ChatThread]) throws -> String {
    let first = sidebarOrder(threads).first(where: { $0.pinnedAt != nil })
    return try ChatPinOrder.key(between: nil, and: first.map(pinRank))
  }

  public struct PinOrderUpdate: Equatable, Sendable {
    public let threadID: String
    public let pinOrder: String
  }

  public enum PinPlacement: Sendable { case before, after }

  /// Ports the PWA's `moveChatThreadPinOrder`: only the moved rank changes, plus the run
  /// of tied ranks it lands in when the insertion gap has no room.
  public static func movePinOrder(
    _ threads: [ChatThread], threadID: String, targetID: String, placement: PinPlacement
  ) throws -> [PinOrderUpdate] {
    let ordered = sidebarOrder(threads.filter { $0.pinnedAt != nil })
    guard threadID != targetID, let moved = ordered.first(where: { $0.id == threadID }) else {
      return []
    }
    let remaining = ordered.filter { $0.id != threadID }
    guard let target = remaining.firstIndex(where: { $0.id == targetID }) else { return [] }
    let index = target + (placement == .after ? 1 : 0)
    if index < ordered.count, ordered[index].id == threadID { return [] }
    let lower = index > 0 ? pinRank(remaining[index - 1]) : nil
    let upper = index < remaining.count ? pinRank(remaining[index]) : nil
    guard let lower, lower == upper else {
      return [
        PinOrderUpdate(
          threadID: threadID, pinOrder: try ChatPinOrder.key(between: lower, and: upper))
      ]
    }
    var end = index
    while end < remaining.count, pinRank(remaining[end]) == lower { end += 1 }
    let affected = [moved] + remaining[index..<end]
    let keys = try ChatPinOrder.keys(
      between: lower, and: end < remaining.count ? pinRank(remaining[end]) : nil,
      count: affected.count)
    return zip(affected, keys).map { PinOrderUpdate(threadID: $0.id, pinOrder: $1) }
  }

  private static func apply(
    _ event: ChatThreadChange,
    to threads: inout [String: ChatThread],
    pendingUpdates: inout [String: [ChatThreadChange]]
  ) {
    if event.kind == .created {
      threads[event.chatThreadId] = ChatThread(
        id: event.chatThreadId,
        agentID: event.agentId,
        title: event.title ?? "",
        projectId: event.projectId,
        selectedModel: event.selectedModel,
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
        sortAt: event.createdAt,
        pinnedAt: nil,
        pinOrder: nil,
        modelSettings: event.modelSettings ?? [:],
        serviceTier: event.serviceTier,
        computerUseHostId: event.computerUseHostId,
        cloudBrowserEnabled: event.cloudBrowserEnabled ?? false,
        isHidden: event.hidden ?? false)

      let deferred = pendingUpdates.removeValue(forKey: event.chatThreadId) ?? []
      for update in deferred where update.createdAt >= event.createdAt {
        apply(update, to: &threads, pendingUpdates: &pendingUpdates)
      }
      return
    }

    if event.kind == .deleted {
      threads[event.chatThreadId] = nil
      return
    }

    guard var thread = threads[event.chatThreadId] else {
      if isDeferrable(event.kind) {
        pendingUpdates[event.chatThreadId, default: []].append(event)
      }
      return
    }

    if event.kind == .sortTouched, let hidden = event.hidden {
      thread.isHidden = hidden
      threads[event.chatThreadId] = thread
      return
    }

    if event.kind == .sortTouched, let muted = event.muted {
      thread.isMuted = muted
      threads[event.chatThreadId] = thread
      return
    }

    // An explicit rank moves a pinned thread without changing activity or
    // updated time. Canonical agent reassignment applies to every thread.
    if event.kind == .sortTouched, let rank = event.pinOrder {
      thread.agentID = event.reassignedAgentId ?? thread.agentID
      if thread.pinnedAt != nil {
        thread.pinOrder = rank
      }
      threads[event.chatThreadId] = thread
      return
    }

    switch event.kind {
    case .renamed:
      thread.title = event.title ?? ""
      thread.renamedAt = event.createdAt
    case .pinned:
      thread.pinnedAt = event.createdAt
      thread.pinOrder = event.pinOrder
    case .unpinned:
      thread.pinnedAt = nil
      thread.pinOrder = nil
    case .archived: thread.isArchived = true
    case .unarchived: thread.isArchived = false
    case .modelSelectionUpdated:
      thread.selectedModel = event.selectedModel
      if let patch = event.modelSettingsPatch {
        thread.modelSettings[patch.model] = ThreadModelSetting(effort: patch.effort)
      }
    case .serviceTierUpdated: thread.serviceTier = event.serviceTier
    case .computerUseHostUpdated:
      thread.computerUseHostId = event.computerUseHostId
      thread.cloudBrowserEnabled = event.cloudBrowserEnabled ?? false
    case .sortTouched:
      thread.agentID = event.reassignedAgentId ?? thread.agentID
      if event.createdAt > thread.sortAt { thread.sortAt = event.createdAt }
      threads[event.chatThreadId] = thread
      return
    case .projectUpdated:
      thread.projectId = event.projectId
    case .created, .deleted:
      return
    }

    thread.updatedAt = event.createdAt
    threads[event.chatThreadId] = thread
  }

  private static func isDeferrable(_ kind: ChatThreadChange.Kind) -> Bool {
    switch kind {
    case .modelSelectionUpdated, .serviceTierUpdated, .computerUseHostUpdated, .projectUpdated:
      true
    default:
      false
    }
  }

  private static func replayOrder(_ left: ChatThread, _ right: ChatThread) -> Bool {
    if (left.pinnedAt != nil) != (right.pinnedAt != nil) { return left.pinnedAt != nil }
    if left.sortAt != right.sortAt { return left.sortAt > right.sortAt }
    return left.id > right.id
  }

  private static func pinRank(_ thread: ChatThread) -> String {
    if let pinOrder = thread.pinOrder { return pinOrder }
    guard let pinnedAt = thread.pinnedAt else { return "" }
    // JS Date.parse truncates fractional seconds to milliseconds. Historical
    // web pins use this rank until they receive an explicit fractional key.
    let milliseconds = Int64(pinnedAt.timeIntervalSince1970 * 1_000)
    let reversed = String(8_640_000_000_000_000 - milliseconds)
    return "a0" + String(repeating: "0", count: max(0, 17 - reversed.count)) + reversed + "1"
  }
}
