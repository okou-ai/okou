import Foundation

/// Realtime signals select durable reads; their payloads are never chat state.
enum ChatInvalidation: Hashable, Sendable {
  case threadList
  case history(threadID: String)
  case detail(threadID: String)
  case readCursor
  case reconnected

  init?(notification: String) {
    switch notification {
    case "threadListChanged": self = .threadList
    case "chatThreadReadCursorUpdated": self = .readCursor
    default:
      let prefixes = ["chatThreadMessageCreated:", "chatThreadDetailChanged:"]
      guard let prefix = prefixes.first(where: { notification.hasPrefix($0) }) else { return nil }
      let id = String(notification.dropFirst(prefix.count))
      guard UUID(uuidString: id) != nil else { return nil }
      self = prefix == prefixes[0] ? .history(threadID: id) : .detail(threadID: id)
    }
  }
}

enum RealtimeConnectionStatus: Sendable {
  case connecting, connected, unavailable, disconnected

  var label: String {
    switch self {
    case .connecting: "Connecting"
    case .connected: "Connected"
    case .unavailable: "Live updates unavailable. Pull to refresh."
    case .disconnected: "Disconnected"
    }
  }
}
