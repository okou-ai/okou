import ChatDomain
import Foundation

/// A portable access link, bound to the conversation that presents it.
public struct ChatComputerAuthorizationAction: Hashable, Sendable {
  public enum Kind: String, Hashable, Sendable { case computerUse, browser, shell }
  public let kind: Kind
  public let identifier: String
  public let originalURL: URL
  public let threadID: String
  public let callbackPrompt: String?
  public let isValid: Bool

  public static func parse(_ value: String, webURL: URL, threadID: String) -> Self? {
    guard let url = URL(string: value, relativeTo: webURL)?.absoluteURL,
      let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
      let origin = URLComponents(url: webURL, resolvingAgainstBaseURL: false),
      ["https", "http"].contains(parts.scheme?.lowercased() ?? ""),
      parts.scheme?.lowercased() == origin.scheme?.lowercased(),
      parts.host?.lowercased() == origin.host?.lowercased(),
      (parts.port ?? (parts.scheme == "https" ? 443 : 80))
        == (origin.port ?? (origin.scheme == "https" ? 443 : 80)),
      parts.user == nil, parts.password == nil
    else { return nil }
    let path = parts.path.split(separator: "/", omittingEmptySubsequences: false)
    let kind: Kind
    let identifier: String
    if path.count == 4, path[2] == "authorize",
      path[1] == "computer-use" || path[1] == "browser"
    {
      kind = path[1] == "browser" ? .browser : .computerUse
      identifier = String(path[3])
    } else if path.count == 5, path[1] == "computer-use", path[2] == "shell",
      path[3] == "authorize"
    {
      kind = .shell
      identifier = String(path[4]).lowercased()
    } else {
      return nil
    }
    var decoded = parts
    decoded.percentEncodedQuery = parts.percentEncodedQuery?.replacingOccurrences(
      of: "+", with: "%20")
    let query = decoded.queryItems ?? []
    let prompt = query.first { $0.name == "callbackPrompt" }?.value
    let callbackThread = query.first { $0.name == "threadId" }?.value
    let validCallback =
      (!query.contains { $0.name == "callbackPrompt" || $0.name == "threadId" })
      || (prompt?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
        && callbackThread?.lowercased() == threadID.lowercased())
    let validIdentifier =
      kind == .shell
      ? UUID(uuidString: identifier) != nil
      : identifier.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil
    return Self(
      kind: kind, identifier: identifier, originalURL: url, threadID: threadID,
      callbackPrompt: prompt,
      isValid: validIdentifier && validCallback && parts.fragment == nil
        && UUID(uuidString: threadID) != nil && Set(query.map(\.name)).count == query.count)
  }

}

/// Confirmed server state shared by the three access controls, not a local grant.
public struct ChatComputerAuthorizationRequest: Equatable, Sendable {
  public struct Host: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let displayName: String
    public let status: String
  }
  public let id: String
  public let status: ChatShellAuthorization.Status
  public let expiresAt: Date
  public let hosts: [Host]
  public let computerUseHostID: String?
  public let computerName: String?
  public let reason: String?
  public let approvalBlockedReason: String?

  public func effectiveStatus(at date: Date) -> ChatShellAuthorization.Status {
    (status == .pending || status == .approved) && expiresAt <= date ? .expired : status
  }
}

private struct ComputerUseAuthorizationResponse: Decodable, Sendable {
  let id: String
  let source: String
  let chatThreadId: String?
  let expiresAt: Date
  let completedAt: Date?
  let computerUseHostId: String?
  let hosts: [ChatComputerAuthorizationRequest.Host]
}

private struct BrowserAuthorizationResponse: Decodable, Sendable {
  let id: String
  let chatThreadId: String
  let expiresAt: Date
  let completedAt: Date?
  let cloudBrowserEnabled: Bool
}

extension APIClient {
  public func computerAuthorization(_ action: ChatComputerAuthorizationAction) async throws
    -> ChatComputerAuthorizationRequest
  {
    guard action.isValid else { throw APIClientError.invalidURL }
    let value: ChatComputerAuthorizationRequest
    let threadID: String?
    switch action.kind {
    case .computerUse:
      let result: ComputerUseAuthorizationResponse = try await request(
        "/api/computer-use/authorization-requests/\(action.identifier)")
      guard result.source == "chat" else { throw APIClientError.invalidResponse }
      threadID = result.chatThreadId
      value = ChatComputerAuthorizationRequest(
        id: result.id, status: result.completedAt == nil ? .pending : .approved,
        expiresAt: result.expiresAt, hosts: result.hosts,
        computerUseHostID: result.computerUseHostId, computerName: nil, reason: nil,
        approvalBlockedReason: nil)
    case .browser:
      let result: BrowserAuthorizationResponse = try await request(
        "/api/browser/authorization-requests/\(action.identifier)")
      threadID = result.chatThreadId
      value = ChatComputerAuthorizationRequest(
        id: result.id, status: result.completedAt == nil ? .pending : .approved,
        expiresAt: result.expiresAt, hosts: [], computerUseHostID: nil,
        computerName: nil, reason: nil, approvalBlockedReason: nil)
    case .shell:
      let result = try await shellAuthorization(id: action.identifier)
      threadID = result.chatThreadId
      value = ChatComputerAuthorizationRequest(
        id: result.id, status: result.status,
        expiresAt: result.status == .approved
          ? (result.grantExpiresAt ?? .distantPast) : result.requestExpiresAt,
        hosts: [], computerUseHostID: result.computerUseHostId,
        computerName: result.computerName, reason: result.reason,
        approvalBlockedReason: result.approvalBlockedReason)
    }
    guard threadID?.lowercased() == action.threadID.lowercased(), UUID(uuidString: value.id) != nil
    else { throw ChatError.invalidContract("This authorization belongs to a different chat.") }
    return value
  }

  public func applyComputerAuthorization(
    _ action: ChatComputerAuthorizationAction, hostID: String?
  ) async throws {
    guard action.isValid else { throw APIClientError.invalidURL }
    switch action.kind {
    case .computerUse:
      guard let hostID, UUID(uuidString: hostID) != nil else { throw APIClientError.invalidURL }
      try await data(
        "/api/computer-use/authorization-requests/\(action.identifier)/apply", method: "POST",
        body: JSONEncoder().encode(["computerUseHostId": hostID]))
    case .browser:
      try await data(
        "/api/browser/authorization-requests/\(action.identifier)/apply", method: "POST",
        body: Data("{}".utf8))
    case .shell:
      _ = try await approveShellAuthorization(id: action.identifier)
    }
  }
}
