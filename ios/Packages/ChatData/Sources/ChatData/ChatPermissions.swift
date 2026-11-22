import ChatDomain
import Foundation

public struct ChatPermissionRule: Equatable, Sendable {
  public let connectorSlug: String
  public let permission: String
  public let action: ChatPermissionAction.Action
  public let expiresAt: Date?
  public func isActive(at date: Date) -> Bool { expiresAt.map { $0 > date } ?? true }
}

struct MemberConnectorPermissions: Decodable, Sendable {
  struct Grant: Decodable, Sendable {
    let permission: String
    let action: ChatPermissionAction.Action
    let expiresAt: Date?
  }
  let target: ChatConnectorTarget
  let grants: [Grant]

  func rules(slug: String) throws -> [ChatPermissionRule] {
    guard target == .builtin(slug) else { throw APIClientError.invalidResponse }
    return grants.map {
      ChatPermissionRule(
        connectorSlug: slug, permission: $0.permission, action: $0.action, expiresAt: $0.expiresAt)
    }
  }
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
  public struct Categories: Decodable, Sendable {
    public let categories: [String: String]
    public let displayOrder: [String]
  }
  public let connectorSlug: String
  public let label: String
  public let permissions: [Permission]
  public let defaultPolicy: Defaults
  public let categories: Categories?

  public func contains(_ permission: String) -> Bool {
    permission == "__unknown__" || permissions.contains { $0.name == permission }
  }

  public func policy(
    for permission: String, grants: [ChatPermissionRule], at date: Date
  ) -> Policy {
    if let grant = grants.last(where: {
      $0.connectorSlug == connectorSlug && $0.permission == permission && $0.isActive(at: date)
    }) {
      return grant.action == .allow ? .allow : .deny
    }
    if permission == "__unknown__" { return defaultPolicy.unknownPolicy }
    for policy: Policy in [.ask, .deny, .allow]
    where defaultPolicy.permissionOverrides?[policy.rawValue]?.contains(permission) == true {
      return policy
    }
    return defaultPolicy.permissionDefault
  }
}

public struct ChatPermissionSnapshot: Sendable {
  public let metadata: ChatPermissionMetadata?
  public let grants: [ChatPermissionRule]
}

/// Uses the same current-user grants and catalog metadata as the PWA permission card.
public struct ChatPermissions: Sendable {
  private let client: APIClient
  public init(client: APIClient) { self.client = client }

  public func load(_ action: ChatPermissionAction) async throws -> ChatPermissionSnapshot {
    try validateMember(action.member)
    return try await connectorPermissions(slug: action.connectorSlug)
  }

  public func apply(
    _ action: ChatPermissionAction, duration: ChatPermissionAction.Duration,
    reviewing current: ChatPermissionSnapshot
  ) async throws -> ChatPermissionSnapshot {
    try await validateContext(action)
    guard let metadata = current.metadata, metadata.connectorSlug == action.connectorSlug,
      metadata.contains(action.permission)
    else {
      throw ChatError.invalidContract("This permission is no longer available.")
    }
    if current.grants.contains(where: {
      $0.connectorSlug == action.connectorSlug && $0.permission == action.permission
        && $0.action == action.action && $0.isActive(at: .now)
    }) {
      return current
    }
    let result = try await applyConnectorPermissions(
      slug: action.connectorSlug,
      edits: [
        ChatPermissionEdit(
          permission: action.permission, action: action.action.rawValue,
          expiresIn: action.action == .allow ? duration.rawValue : nil)
      ])
    guard
      result.contains(where: {
        $0.permission == action.permission && $0.action == action.action && $0.isActive(at: .now)
      })
    else { throw APIClientError.invalidResponse }
    return ChatPermissionSnapshot(
      metadata: metadata, grants: result)
  }

  func connectorPermissions(slug: String) async throws -> ChatPermissionSnapshot {
    async let rules = connectorGrants(slug: slug)
    async let metadata = self.metadata(slug: slug)
    return try await ChatPermissionSnapshot(metadata: metadata, grants: rules)
  }

  func connectorGrants(slug: String) async throws -> [ChatPermissionRule] {
    let result: MemberConnectorPermissions = try await client.request(
      "/api/connector-permissions", query: ChatConnectorTarget.builtin(slug).query)
    return try result.rules(slug: slug)
  }

  func metadata(slug: String) async throws -> ChatPermissionMetadata? {
    struct Metadata: Decodable, Sendable { let permissions: ChatPermissionMetadata }
    do {
      let result: Metadata = try await client.request("/api/connector-catalog/\(slug)/permissions")
      guard result.permissions.connectorSlug == slug else { throw APIClientError.invalidResponse }
      return result.permissions
    } catch let error as APIClientError where error.statusCode == 404 {
      return nil
    }
  }

  func applyConnectorPermissions(slug: String, edits: [ChatPermissionEdit], reset: Bool = false)
    async throws -> [ChatPermissionRule]
  {
    struct Body: Encodable {
      let target: ChatConnectorTarget
      let mode: String
      let grants: [ChatPermissionEdit]
    }
    let result: MemberConnectorPermissions = try await client.request(
      "/api/connector-permissions", method: "PUT",
      body: JSONEncoder().encode(
        Body(target: .builtin(slug), mode: reset ? "replace" : "patch", grants: edits)))
    return try result.rules(slug: slug)
  }

  public func validateContext(_ action: ChatPermissionAction) async throws {
    try await validateContext(
      member: action.member, callbackThreadID: action.callbackPrompt == nil ? nil : action.threadID)
  }

  func validateMember(_ member: WorkspaceMemberID) throws {
    // This client obtains every token from its original user/session/workspace scope.
    guard client.member == member else {
      throw ChatError.invalidContract(
        "This permission request belongs to a different workspace member.")
    }
  }

  func validateContext(member: WorkspaceMemberID, callbackThreadID: String?) async throws {
    try validateMember(member)
    guard let callbackThreadID else { return }
    let thread: ThreadMetadata = try await client.request(
      "/api/chat-threads/\(callbackThreadID)/metadata")
    guard UUID(uuidString: thread.id) == UUID(uuidString: callbackThreadID)
    else { throw ChatError.invalidContract("This request no longer belongs to this chat.") }
  }
}
