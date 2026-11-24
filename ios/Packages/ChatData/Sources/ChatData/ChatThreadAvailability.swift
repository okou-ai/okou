import Foundation

/// Only use for authenticated routes whose NOT_FOUND identifies the parent chat itself.
func withExistingChatThread<Value: Sendable>(
  _ id: String, _ operation: @Sendable () async throws -> Value
) async throws -> Value {
  do {
    return try await operation()
  } catch APIClientError.http(404, _, "NOT_FOUND", _) {
    throw UnavailableChatThread(id: id)
  }
}

public struct UnavailableChatThread: LocalizedError {
  public let id: String
  public var errorDescription: String? { String(localized: "This chat is no longer available.") }
}
