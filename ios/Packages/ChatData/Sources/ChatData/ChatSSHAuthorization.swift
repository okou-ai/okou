import ChatDomain
import Foundation

/// A trusted SSH review link identifies a request; only the server can grant access.
public struct ChatSSHAuthorizationAction: Hashable, Sendable {
  public let id: String
  public let threadID: String
  public let originalURL: URL

  public static func parse(_ value: String, webURL: URL, threadID: String) -> Self? {
    guard let url = URL(string: value, relativeTo: webURL)?.absoluteURL,
      let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
      let origin = URLComponents(url: webURL, resolvingAgainstBaseURL: false),
      ["http", "https"].contains(parts.scheme?.lowercased() ?? ""),
      parts.scheme?.lowercased() == origin.scheme?.lowercased(),
      parts.host?.lowercased() == origin.host?.lowercased(),
      (parts.port ?? (parts.scheme == "https" ? 443 : 80))
        == (origin.port ?? (origin.scheme == "https" ? 443 : 80)),
      parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
      UUID(uuidString: threadID) != nil
    else { return nil }
    let path = parts.percentEncodedPath.split(separator: "/", omittingEmptySubsequences: false)
    guard path.count == 4, path[1] == "ssh", path[2] == "authorize",
      let id = UUID(uuidString: String(path[3]))
    else { return nil }
    return Self(id: id.uuidString.lowercased(), threadID: threadID.lowercased(), originalURL: url)
  }
}

public struct ChatSSHAuthorization: Decodable, Equatable, Sendable {
  public enum Status: String, Decodable, Sendable {
    case pending, approved, denied, expired, revoked, stale
  }

  public let id: String
  public let chatThreadId: String
  public let connectionId: String
  public let displayName: String
  public let username: String
  public let host: String
  public let port: Int
  public let reason: String
  public let status: Status
  public let requestExpiresAt: Date
  public let enabled: Bool
  public let continuationPending: Bool
  public let approvalBlockedReason: String?
  public let requiredPermissions: [ChatPermissionBatchAction.Item]

  public var target: String { "\(username)@\(host):\(port)" }

  public func effectiveStatus(at date: Date) -> Status {
    status == .pending && requestExpiresAt <= date ? .expired : status
  }
}

extension APIClient {
  public func sshAuthorization(_ action: ChatSSHAuthorizationAction) async throws
    -> ChatSSHAuthorization
  {
    let result: ChatSSHAuthorization = try await request("/api/ssh/authorizations/\(action.id)")
    return try validateSSHAuthorization(result, action: action)
  }

  public func approveSSHAuthorization(_ action: ChatSSHAuthorizationAction) async throws
    -> ChatSSHAuthorization
  {
    let result: ChatSSHAuthorization = try await request(
      "/api/ssh/authorizations/\(action.id)/approve", method: "POST", body: Data("{}".utf8))
    return try validateSSHAuthorization(result, action: action)
  }

  public func revokeSSHAuthorization(_ action: ChatSSHAuthorizationAction) async throws
    -> ChatSSHAuthorization
  {
    let result: ChatSSHAuthorization = try await request(
      "/api/ssh/authorizations/\(action.id)/revoke", method: "POST", body: Data("{}".utf8))
    return try validateSSHAuthorization(result, action: action)
  }

  private func validateSSHAuthorization(
    _ result: ChatSSHAuthorization, action: ChatSSHAuthorizationAction
  ) throws -> ChatSSHAuthorization {
    guard result.id.lowercased() == action.id,
      result.chatThreadId.lowercased() == action.threadID
    else { throw ChatError.invalidContract("This authorization belongs to a different chat.") }
    return result
  }
}
