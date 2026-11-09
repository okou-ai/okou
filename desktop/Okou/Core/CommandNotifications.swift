import Foundation

public struct CommandNotificationSubscription: Sendable {
  public let channelName: String
  public let eventName: String
  public let presenceEnabled: Bool

  public init(channelName: String, eventName: String, presenceEnabled: Bool = false) {
    self.channelName = channelName
    self.eventName = eventName
    self.presenceEnabled = presenceEnabled
  }
}

public enum CommandNotificationEvent: Sendable {
  case ready
  case refresh
  case unavailable(String, code: Int? = nil)
}

/// The SDK adapter owns transport and token renewal; the runtime owns commands.
public protocol CommandNotifications: Sendable {
  func start(
    subscription: CommandNotificationSubscription,
    tokenProvider: @escaping @Sendable () async throws -> JSONValue
  ) async throws -> AsyncStream<CommandNotificationEvent>
  func setAvailable(_ available: Bool, channelName: String) async
  func stop() async
}

// Non-presence notification adapters have no availability membership to change.
extension CommandNotifications {
  public func setAvailable(_ available: Bool, channelName: String) async {}
}
