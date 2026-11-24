import Foundation

extension APIClientError {
  public var isResourceNotFound: Bool { statusCode == 404 && serverCode == "NOT_FOUND" }
}

/// Only use for authenticated routes whose NOT_FOUND identifies the parent chat itself.
func withExistingChatThread<Value: Sendable>(
  _ id: String, _ operation: @Sendable () async throws -> Value
) async throws -> Value {
  do {
    return try await operation()
  } catch let error as APIClientError where error.isResourceNotFound {
    throw UnavailableChatThread(id: id)
  }
}

public struct UnavailableChatThread: LocalizedError {
  public let id: String
  public var errorDescription: String? { String(localized: "This chat is no longer available.") }
}
