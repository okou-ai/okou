import Foundation

/// Realtime signals select durable reads; their payloads are never chat state.
enum ChatInvalidation: Hashable, Sendable {
  case startup
  case initialSubscriptions
  case foregroundResume
  case realtimeResume
  case realtimeGap
  case computerAccess
  case runModels
  case modelPreference
  case threadList
  case indicators
  case history(threadID: String)
  case detail(threadID: String)
  case readCursor
  case reconnected

  var requiresFullRefresh: Bool {
    self == .startup || self == .initialSubscriptions || self == .reconnected
      || self == .foregroundResume || self == .realtimeGap
  }

  /// Match Web's list baseline: startup, explicit changes, manual retry, and lost continuity.
  var refreshesThreadList: Bool {
    self == .startup || self == .threadList || self == .reconnected || self == .realtimeGap
  }

  var coordinatesModelRecovery: Bool {
    self == .foregroundResume || self == .realtimeResume || self == .realtimeGap
  }

  init?(notification: String) {
    switch notification {
    case "computerUseHostsChanged", "desktopShellAuthorizationChanged", "sshAuthorizationChanged",
      "ssh:changed", "connectorPermissionUpdated", "connector:changed":
      self = .computerAccess
    case "runModelsChanged": self = .runModels
    case "userPreferenceChanged": self = .modelPreference
    case "threadListChanged": self = .threadList
    case "chatIndicatorsChanged": self = .indicators
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

enum ChatSynchronizationState: Equatable {
  case connecting, updating, liveUpdatesUnavailable, updateFailed

  var isFailure: Bool {
    switch self {
    case .connecting, .updating: false
    case .liveUpdatesUnavailable, .updateFailed: true
    }
  }

  var label: String {
    switch self {
    case .connecting: String(localized: "Connecting…")
    case .updating: String(localized: "Updating chats…")
    case .liveUpdatesUnavailable: String(localized: "Live updates unavailable")
    case .updateFailed: String(localized: "Unable to update chats")
    }
  }
}
