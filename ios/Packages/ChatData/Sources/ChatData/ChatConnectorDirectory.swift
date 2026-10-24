import Foundation

public struct ChatCatalogConnector: Decodable, Identifiable, Sendable {
  public let slug: String
  public let label: String
  public let description: String
  public let category: String
  public let authMethods: [ChatConnectorMethod]
  public let permissionSummary: PermissionSummary
  public var id: String { slug }
  public struct PermissionSummary: Decodable, Sendable { public let hasPermissions: Bool }
}

public struct ChatConnectorDiscovery: Decodable, Sendable {
  public let connectors: [ChatCatalogConnector]
  public let totalConnectorCount: Int
  public let categoryConnectorCounts: [String: Int]?
}

public struct ChatConnectorPermissionState: Sendable {
  public let metadata: ChatPermissionMetadata
  public let grants: [ChatPermissionGrant]
}

public struct ChatPermissionEdit: Encodable, Sendable {
  public let permission: String
  public let action: String
  public let expiresIn: String?
  public init(permission: String, action: String, expiresIn: String? = nil) {
    self.permission = permission
    self.action = action
    self.expiresIn = action == "allow" ? expiresIn : nil
  }
}

extension ChatComposerAccess {
  public var desktopDownloadURL: URL {
    client.baseURL.appending(path: "api/desktop/updates/stable/darwin/arm64/dmg")
  }

  public func validate(agentID: String, threadID: String?) async throws {
    if let threadID {
      let metadata: ThreadMetadata = try await client.request("/api/chat-threads/\(threadID)/metadata")
      guard metadata.agentId.lowercased() == agentID.lowercased() else {
        throw APIClientError.http(status: 409, message: "This chat's Agent changed. Close and reopen Connectors.")
      }
    } else {
      struct Agent: Decodable, Sendable { let agentId: String }
      let agent: Agent = try await client.request("/api/agents/\(agentID)")
      guard agent.agentId.lowercased() == agentID.lowercased() else {
        throw APIClientError.invalidResponse
      }
    }
  }

  public func discover(keyword: String = "", category: String? = nil) async throws
    -> ChatConnectorDiscovery
  {
    var query: [URLQueryItem] = []
    if !keyword.isEmpty { query.append(URLQueryItem(name: "keyword", value: keyword)) }
    if let category { query.append(URLQueryItem(name: "category", value: category)) }
    return try await client.request("/api/connector-catalog/discovery", query: query)
  }

  public func customConnectors() async throws -> [ChatCustomConnector] {
    struct Response: Decodable, Sendable { let connectors: [ChatCustomConnector] }
    let result: Response = try await client.request("/api/custom-connectors")
    return result.connectors
  }

  public func permissions(slug: String, agentID: String) async throws -> ChatConnectorPermissionState {
    struct Metadata: Decodable, Sendable { let permissions: ChatPermissionMetadata }
    async let metadata: Metadata = client.request("/api/connector-catalog/\(slug)/permissions")
    async let grants: [ChatPermissionGrant] = client.request(
      "/api/user-permission-grants", query: [URLQueryItem(name: "agentId", value: agentID)])
    let (detail, current) = try await (metadata, grants)
    guard detail.permissions.connectorSlug == slug else { throw APIClientError.invalidResponse }
    return ChatConnectorPermissionState(
      metadata: detail.permissions, grants: current.filter { $0.connectorSlug == slug })
  }

  public func savePermissions(
    slug: String, agentID: String, edits: [ChatPermissionEdit], reset: Bool = false
  ) async throws {
    struct Body: Encodable {
      let agentId: String
      let connectorSlug: String
      let mode: String
      let grants: [ChatPermissionEdit]
    }
    try await client.data(
      "/api/user-permission-grants/apply", method: "PUT",
      body: JSONEncoder().encode(Body(
        agentId: agentID, connectorSlug: slug, mode: reset ? "replace" : "patch", grants: edits)))
  }
}
