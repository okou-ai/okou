import Foundation

/// Replays the thread snapshot and its ordered lifecycle tail. This follows
/// `replayChatThreadEvents` in the web client; display-specific pin ranking is
/// applied separately by `sidebarOrder`.
enum ChatThreadReplay {
  static func replay(snapshot: [ThreadProjection], events: [ThreadEvent]) -> [ChatThread] {
    var threads: [String: ChatThread] = [:]
    for thread in snapshot { threads[thread.id] = thread.thread }
    var pendingUpdates: [String: [ThreadEvent]] = [:]

    for event in events {
      apply(event, to: &threads, pendingUpdates: &pendingUpdates)
    }
    return threads.values.sorted(by: replayOrder)
  }

  /// Matches the web sidebar's separate `comparePinnedThreads` pass. Unpinned
  /// threads retain the reducer's activity order.
  static func sidebarOrder(_ threads: [ChatThread]) -> [ChatThread] {
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

  private static func apply(
    _ event: ThreadEvent,
    to threads: inout [String: ChatThread],
    pendingUpdates: inout [String: [ThreadEvent]]
  ) {
    if event.kind == .created {
      threads[event.chatThreadId] = ChatThread(
        id: event.chatThreadId,
        agentID: event.agentId,
        title: event.title ?? "",
        selectedModel: event.selectedModel,
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
        sortAt: event.createdAt,
        pinnedAt: nil,
        pinOrder: nil,
        modelSettings: event.modelSettings ?? [:],
        serviceTier: event.serviceTier,
        computerUseHostId: event.computerUseHostId,
        cloudBrowserEnabled: event.cloudBrowserEnabled ?? false)

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
    case .created, .deleted:
      return
    }

    thread.updatedAt = event.createdAt
    threads[event.chatThreadId] = thread
  }

  private static func isDeferrable(_ kind: ThreadEvent.Kind) -> Bool {
    switch kind {
    case .modelSelectionUpdated, .serviceTierUpdated, .computerUseHostUpdated:
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
