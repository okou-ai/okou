import Foundation

public struct CommandNotificationSubscription: Sendable {
  public let channelName: String
  public let eventName: String

  public init(channelName: String, eventName: String) {
    self.channelName = channelName
    self.eventName = eventName
  }
}

public enum CommandNotificationEvent: Sendable {
  case refresh
  case unavailable(String)
}

/// The SDK adapter owns transport and token renewal; the runtime owns commands.
public protocol CommandNotifications: Sendable {
  func start(
    subscription: CommandNotificationSubscription,
    tokenProvider: @escaping @Sendable () async throws -> JSONValue
  ) async throws -> AsyncStream<CommandNotificationEvent>
  func stop() async
}
