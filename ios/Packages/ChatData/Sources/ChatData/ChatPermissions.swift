import ChatDomain
import Foundation

public struct ChatPermissionGrant: Decodable, Equatable, Sendable {
  public let agentId: String
  public let connectorSlug: String
  public let permission: String
  public let action: ChatPermissionAction.Action
  public let expiresAt: Date?

  public func isActive(at date: Date) -> Bool { expiresAt.map { $0 > date } ?? true }
}

public struct ChatPermissionMetadata: Decodable, Sendable {
  public enum Policy: String, Decodable, Sendable { case allow, deny, ask }
  public struct Permission: Decodable, Sendable {
    public let name: String
    public let description: String?
  }
  public struct Defaults: Decodable, Sendable {
    public let permissionDefault: Policy
    public let permissionOverrides: [String: [String]]?
    public let unknownPolicy: Policy
  }
  public let connectorSlug: String
  public let label: String
  public let permissions: [Permission]
  public let defaultPolicy: Defaults

  public func contains(_ permission: String) -> Bool {
    permission == "__unknown__" || permissions.contains { $0.name == permission }
  }

  public func policy(for permission: String, grants: [ChatPermissionGrant], at date: Date) -> Policy
  {
    if let grant = grants.last(where: {
      $0.connectorSlug == connectorSlug && $0.permission == permission && $0.isActive(at: date)
    }) {
      return grant.action == .allow ? .allow : .deny
    }
    if permission == "__unknown__" { return defaultPolicy.unknownPolicy }
    for policy: Policy in [.ask, .deny, .allow] {
      if defaultPolicy.permissionOverrides?[policy.rawValue]?.contains(permission) == true {
        return policy
      }
    }
    return defaultPolicy.permissionDefault
  }
}

public struct ChatPermissionSnapshot: Sendable {
  public let agentName: String?
  public let metadata: ChatPermissionMetadata?
  public let grants: [ChatPermissionGrant]
}

/// Uses the same current-user grants and catalog metadata as the PWA permission card.
public struct ChatPermissions: Sendable {
  private let client: APIClient
  public init(client: APIClient) { self.client = client }

  public func load(_ action: ChatPermissionAction) async throws -> ChatPermissionSnapshot {
    try await validateContext(action)
    struct Agent: Decodable, Sendable {
      let agentId: String
      let displayName: String?
    }
    let agent: Agent = try await client.request("/api/agents/\(action.agentID)")
    guard UUID(uuidString: agent.agentId) == UUID(uuidString: action.agentID) else {
      throw APIClientError.invalidResponse
    }
    let grants = try await grants(action)
    struct Metadata: Decodable, Sendable { let permissions: ChatPermissionMetadata }
    let metadata: ChatPermissionMetadata?
    do {
      let response: Metadata = try await client.request(
        "/api/connector-catalog/\(action.connectorSlug)/permissions")
      guard response.permissions.connectorSlug == action.connectorSlug else {
        throw APIClientError.invalidResponse
      }
      metadata = response.permissions
    } catch let error as APIClientError where error.statusCode == 404 {
      metadata = nil
    }
    return ChatPermissionSnapshot(agentName: agent.displayName, metadata: metadata, grants: grants)
  }

  public func apply(_ action: ChatPermissionAction, duration: ChatPermissionAction.Duration)
    async throws -> ChatPermissionGrant
  {
    // Revalidate before writing: the thread may have moved to another Agent while the sheet was open.
    let current = try await load(action)
    guard let metadata = current.metadata, metadata.contains(action.permission) else {
      throw ChatError.invalidContract("This permission is no longer available.")
    }
    if let existing = current.grants.last(where: {
      $0.connectorSlug == action.connectorSlug && $0.permission == action.permission
        && $0.action == action.action && $0.isActive(at: .now)
    }) {
      return existing
    }
    struct Grant: Encodable {
      let permission: String
      let action: ChatPermissionAction.Action
      let expiresIn: ChatPermissionAction.Duration?
    }
    struct Body: Encodable {
      let agentId: String
      let connectorSlug: String
      let mode = "patch"
      let grants: [Grant]
    }
    let body = Body(
      agentId: action.agentID, connectorSlug: action.connectorSlug,
      grants: [
        Grant(
          permission: action.permission, action: action.action,
          expiresIn: action.action == .allow ? duration : nil)
      ])
    let result: [ChatPermissionGrant] = try await client.request(
      "/api/user-permission-grants/apply", method: "PUT", body: JSONEncoder().encode(body))
    guard let grant = result.first, result.count == 1,
      UUID(uuidString: grant.agentId) == UUID(uuidString: action.agentID),
      grant.connectorSlug == action.connectorSlug, grant.permission == action.permission,
      grant.action == action.action, grant.isActive(at: .now)
    else { throw APIClientError.invalidResponse }
    return grant
  }

  public func validateContext(_ action: ChatPermissionAction) async throws {
    let thread: ThreadMetadata = try await client.request(
      "/api/chat-threads/\(action.threadID)/metadata")
    guard UUID(uuidString: thread.id) == UUID(uuidString: action.threadID),
      UUID(uuidString: thread.agentId) == UUID(uuidString: action.agentID)
    else { throw ChatError.invalidContract("This request no longer belongs to this conversation.") }
  }

  private func grants(_ action: ChatPermissionAction) async throws -> [ChatPermissionGrant] {
    let grants: [ChatPermissionGrant] = try await client.request(
      "/api/user-permission-grants", query: [URLQueryItem(name: "agentId", value: action.agentID)])
    guard grants.allSatisfy({ UUID(uuidString: $0.agentId) == UUID(uuidString: action.agentID) })
    else {
      throw APIClientError.invalidResponse
    }
    return grants
  }
}
