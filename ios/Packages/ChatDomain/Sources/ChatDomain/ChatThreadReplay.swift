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

  /// The prepend-only subset of fractional-indexing's generateKeyBetween(null, first).
  /// Keep the base-62 keys compatible with the PWA and the existing pin API.
  public static func firstPinOrder(_ threads: [ChatThread]) throws -> String {
    guard let first = sidebarOrder(threads).first(where: { $0.pinnedAt != nil }) else {
      return "a0"
    }
    let key = Array(pinRank(first).utf8)
    let digits = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz".utf8)
    guard let head = key.first else { throw ChatError.invalidContract("Invalid pin order.") }
    let length: Int
    switch head {
    case 97...122: length = Int(head - 97) + 2
    case 65...90: length = Int(90 - head) + 2
    default: throw ChatError.invalidContract("Invalid pin order.")
    }
    guard key.count >= length, key.dropFirst().allSatisfy({ digits.contains($0) }),
      key.count == length || key.last != digits[0]
    else { throw ChatError.invalidContract("Invalid pin order.") }
    var integer = Array(key.prefix(length))
    let fraction = Array(key.dropFirst(length))
    if head == 65, integer.dropFirst().allSatisfy({ $0 == digits[0] }) {
      guard let index = fraction.firstIndex(where: { $0 != digits[0] }),
        let digit = digits.firstIndex(of: fraction[index])
      else { throw ChatError.invalidContract("Invalid pin order.") }
      let prefix = Array(fraction.prefix(index))
      let midpoint: [UInt8] =
        digit > 1
        ? [digits[(digit + 1) / 2]]
        : (index + 1 < fraction.count ? [digits[1]] : [digits[0], digits[31]])
      return String(decoding: integer + prefix + midpoint, as: UTF8.self)
    }
    if !fraction.isEmpty { return String(decoding: integer, as: UTF8.self) }
    for index in (1..<integer.count).reversed() {
      guard let digit = digits.firstIndex(of: integer[index]) else {
        throw ChatError.invalidContract("Invalid pin order.")
      }
      if digit > 0 {
        integer[index] = digits[digit - 1]
        return String(decoding: integer, as: UTF8.self)
      }
      integer[index] = digits[61]
    }
    if head == 97 { return "Zz" }
    guard head > 65 else { throw ChatError.invalidContract("Invalid pin order.") }
    integer[0] = head - 1
    if integer[0] < 90 { integer.append(digits[61]) } else { integer.removeLast() }
    return String(decoding: integer, as: UTF8.self)
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
    case .created, .deleted:
      return
    }

    thread.updatedAt = event.createdAt
    threads[event.chatThreadId] = thread
  }

  private static func isDeferrable(_ kind: ChatThreadChange.Kind) -> Bool {
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
