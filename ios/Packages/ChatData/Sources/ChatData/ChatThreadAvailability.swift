import Foundation

enum ChatThreadEndpoint: String {
  case detail = "NOT_FOUND"
  case composerDraft = "CHAT_THREAD_NOT_FOUND"
}

extension APIClientError {
  public var isResourceNotFound: Bool { isMissing(.detail) }

  fileprivate func isMissing(_ endpoint: ChatThreadEndpoint) -> Bool {
    statusCode == 404 && serverCode == endpoint.rawValue
  }
}

/// Only use for authenticated routes whose indicated error code identifies the parent chat itself.
func withExistingChatThread<Value: Sendable>(
  _ id: String, at endpoint: ChatThreadEndpoint, _ operation: @Sendable () async throws -> Value
) async throws -> Value {
  do {
    return try await operation()
  } catch let error as APIClientError where error.isMissing(endpoint) {
    throw UnavailableChatThread(id: id)
  }
}

public struct UnavailableChatThread: LocalizedError {
  public let id: String
  public var errorDescription: String? { String(localized: "This chat is no longer available.") }
}
