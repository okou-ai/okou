import Foundation

public struct ChatConnectorTarget: Codable, Equatable, Sendable {
  public let kind: String
  public let connectorSlug: String?
  public let customConnectorId: String?
  public var query: [URLQueryItem] {
    [URLQueryItem(name: "kind", value: kind)]
      + (connectorSlug.map { [URLQueryItem(name: "connectorSlug", value: $0)] } ?? [])
      + (customConnectorId.map { [URLQueryItem(name: "customConnectorId", value: $0)] } ?? [])
  }
  public static func builtin(_ slug: String) -> Self {
    Self(kind: "builtin", connectorSlug: slug, customConnectorId: nil)
  }
  public static func custom(_ id: String) -> Self {
    Self(kind: "custom", connectorSlug: nil, customConnectorId: id.lowercased())
  }
}

/// A trusted action reference is still subject to current server ownership and authorization.
public struct ChatConnectorAction: Equatable, Sendable, Identifiable {
  public enum Kind: Equatable, Sendable {
    case connect(slug: String)
    case reconnect(slug: String, connectionID: String)
    case select(target: ChatConnectorTarget, connectionID: String)
    case unavailable
  }
  public let id: String
  public let kind: Kind
  public let agentID: String
  public let threadID: String
  public let callbackPrompt: String?

  public static func parse(_ value: String, webURL: URL, agentID: String, threadID: String)
    -> Self?
  {
    guard let url = URL(string: value, relativeTo: webURL)?.absoluteURL,
      url.scheme?.lowercased() == webURL.scheme?.lowercased(),
      url.host?.lowercased() == webURL.host?.lowercased(), url.port == webURL.port,
      url.user == nil, url.password == nil,
      var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
    else { return nil }
    let path = components.path.split(separator: "/", omittingEmptySubsequences: false)
    let connectorPath =
      path.count >= 4 && path[1] == "connectors"
      && ["connect", "authorize", "reconnect"].contains(String(path[3]))
    let accountPath =
      path.count == 6 && path[1] == "agents"
      && path[3] == "connector-accounts" && path[5] == "select"
    guard connectorPath || accountPath else { return nil }
    // Match URLSearchParams form decoding without changing percent-encoded literal plus signs.
    components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(
      of: "+", with: "%20")
    let query = components.queryItems ?? []
    func param(_ key: String) -> String? { query.first { $0.name == key }?.value }
    func invalid() -> Self {
      Self(id: value, kind: .unavailable, agentID: agentID, threadID: threadID, callbackPrompt: nil)
    }
    guard Set(query.map(\.name)).count == query.count,
      UUID(uuidString: agentID) != nil, UUID(uuidString: threadID) != nil,
      (connectorPath ? param("agentId") : String(path[2]))?.lowercased() == agentID.lowercased()
    else { return invalid() }
    let prompt = param("callbackPrompt")
    let callbackThread = param("threadId")
    guard
      (prompt == nil && callbackThread == nil)
        || (prompt?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
          && callbackThread?.lowercased() == threadID.lowercased())
    else { return invalid() }
    let kind: Kind
    if connectorPath {
      let slug = String(path[2]).lowercased()
      let builtin = slug.range(of: "^[a-z0-9][a-z0-9-]*$", options: .regularExpression) != nil
      let custom =
        slug.range(of: "^_[a-z0-9][a-z0-9-]{0,60}[a-z0-9]$", options: .regularExpression) != nil
      if path[3] == "reconnect" {
        guard path.count == 5, builtin, UUID(uuidString: String(path[4])) != nil else {
          return invalid()
        }
        kind = .reconnect(slug: slug, connectionID: String(path[4]).lowercased())
      } else {
        guard path.count == 4, builtin || (custom && path[3] == "connect") else { return invalid() }
        kind = .connect(slug: slug)
      }
    } else {
      guard prompt != nil, callbackThread != nil, UUID(uuidString: String(path[4])) != nil else {
        return invalid()
      }
      let target: ChatConnectorTarget
      if param("kind") == "builtin", let slug = param("connectorSlug"),
        slug.range(of: "^[a-z0-9][a-z0-9-]*$", options: .regularExpression) != nil,
        param("customConnectorId") == nil
      {
        target = .builtin(slug)
      } else if param("kind") == "custom", let id = param("customConnectorId"),
        UUID(uuidString: id) != nil, param("connectorSlug") == nil
      {
        target = .custom(id)
      } else {
        return invalid()
      }
      kind = .select(target: target, connectionID: String(path[4]).lowercased())
    }
    return Self(id: value, kind: kind, agentID: agentID, threadID: threadID, callbackPrompt: prompt)
  }
}
