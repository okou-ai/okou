import ChatDomain
import Foundation

public struct ChatPermissionBatchSnapshot: Sendable {
  public struct Group: Identifiable, Sendable {
    public let connectorSlug: String
    public let items: [ChatPermissionBatchAction.Item]
    public let metadata: ChatPermissionMetadata?
    public let grants: [ChatPermissionRule]
    public var id: String { connectorSlug }

    public func allows(_ item: ChatPermissionBatchAction.Item) -> Bool {
      metadata?.contains(item.permission) == true
        && metadata?.policy(for: item.permission, grants: grants, at: .now) == .allow
    }

    public func grant(for item: ChatPermissionBatchAction.Item) -> ChatPermissionRule? {
      grants.last {
        $0.permission == item.permission && $0.action == .allow && $0.isActive(at: .now)
      }
    }
  }

  public let enabled: Bool
  public let agentName: String?
  public let connectorScoped: Bool
  public let groups: [Group]
  public var complete: Bool {
    enabled && !groups.isEmpty
      && groups.allSatisfy { group in
        group.items.allSatisfy { group.metadata?.contains($0.permission) == true }
      }
  }
  public var allowedCount: Int {
    groups.reduce(0) { $0 + $1.items.filter($1.allows).count }
  }
  public var allAllowed: Bool {
    complete && allowedCount == groups.reduce(0) { $0 + $1.items.count }
  }
}

/// Uses the same effective feature switches and current-user grant paths as the PWA.
public struct ChatBatchPermissions: Sendable {
  private let client: APIClient
  public init(client: APIClient) { self.client = client }

  public func load(_ action: ChatPermissionBatchAction) async throws -> ChatPermissionBatchSnapshot
  {
    let features: SidebarFeatureSwitches = try await client.request("/api/feature-switches")
    let shared = features.effectiveSwitches["connectorChatAccountAccess"] == true
    guard features.effectiveSwitches["batchConnectorPermissions"] == true else {
      return ChatPermissionBatchSnapshot(
        enabled: false, agentName: nil, connectorScoped: shared, groups: [])
    }
    struct Agent: Decodable, Sendable {
      let agentId: String
      let displayName: String?
    }
    let agent: Agent = try await client.request("/api/agents/\(action.agentID)")
    guard UUID(uuidString: agent.agentId) == UUID(uuidString: action.agentID) else {
      throw APIClientError.invalidResponse
    }
    let grants: [ChatPermissionRule]
    if shared {
      grants = []
    } else {
      let result: [ChatPermissionGrant] = try await client.request(
        "/api/user-permission-grants", query: [URLQueryItem(name: "agentId", value: action.agentID)]
      )
      guard result.allSatisfy({ UUID(uuidString: $0.agentId) == UUID(uuidString: action.agentID) })
      else { throw APIClientError.invalidResponse }
      grants = result.map(\.rule)
    }
    let permissions = ChatPermissions(client: client)
    let slugs = Set(action.items.map(\.connectorSlug))
    let groups = try await withThrowingTaskGroup(of: ChatPermissionBatchSnapshot.Group.self) {
      tasks in
      for slug in slugs {
        tasks.addTask {
          let metadata: ChatPermissionMetadata?
          let rules: [ChatPermissionRule]
          if shared {
            let snapshot = try await permissions.connectorPermissions(slug: slug)
            metadata = snapshot.metadata
            rules = snapshot.grants
          } else {
            metadata = try await permissions.metadata(slug: slug)
            rules = grants.filter { $0.connectorSlug == slug }
          }
          return ChatPermissionBatchSnapshot.Group(
            connectorSlug: slug, items: action.items.filter { $0.connectorSlug == slug },
            metadata: metadata, grants: rules)
        }
      }
      var result: [ChatPermissionBatchSnapshot.Group] = []
      for try await group in tasks { result.append(group) }
      return result.sorted { $0.connectorSlug < $1.connectorSlug }
    }
    return ChatPermissionBatchSnapshot(
      enabled: true, agentName: agent.displayName, connectorScoped: shared, groups: groups)
  }

  public func validateContext(_ action: ChatPermissionBatchAction) async throws {
    let thread: ThreadMetadata = try await client.request(
      "/api/chat-threads/\(action.threadID)/metadata")
    guard UUID(uuidString: thread.id) == UUID(uuidString: action.threadID),
      UUID(uuidString: thread.agentId) == UUID(uuidString: action.agentID)
    else { throw ChatError.invalidContract("This request no longer belongs to this chat.") }
  }

  public func apply(
    _ action: ChatPermissionBatchAction, duration: ChatPermissionAction.Duration,
    expectedConnectorScoped: Bool
  ) async throws -> ChatPermissionBatchSnapshot {
    try await validateContext(action)
    let current = try await load(action)
    guard current.complete else {
      throw ChatError.invalidContract("These permissions are no longer available.")
    }
    guard current.connectorScoped == expectedConnectorScoped else {
      throw ChatError.invalidContract("Permission scope changed. Review the request again.")
    }
    struct Grant: Encodable {
      let permission: String
      let action = "allow"
      let expiresIn: ChatPermissionAction.Duration
    }
    struct Group: Encodable {
      let connectorSlug: String
      let grants: [Grant]
    }
    let groups = current.groups.compactMap { group -> Group? in
      let missing = group.items.filter { !group.allows($0) }
      return missing.isEmpty
        ? nil
        : Group(
          connectorSlug: group.connectorSlug,
          grants: missing.map { Grant(permission: $0.permission, expiresIn: duration) })
    }
    try Task.checkCancellation()
    if groups.isEmpty { return current }
    if current.connectorScoped {
      let permissions = ChatPermissions(client: client)
      // This path can partially succeed across connectors. The owner must read back on failure.
      for group in groups {
        try Task.checkCancellation()
        let saved = try await permissions.applyConnectorPermissions(
          slug: group.connectorSlug,
          edits: group.grants.map {
            ChatPermissionEdit(
              permission: $0.permission, action: "allow", expiresIn: duration.rawValue)
          })
        guard
          group.grants.allSatisfy({ requested in
            saved.contains {
              $0.permission == requested.permission && $0.action == .allow && $0.isActive(at: .now)
            }
          })
        else { throw APIClientError.invalidResponse }
      }
    } else {
      struct Body: Encodable {
        let agentId: String
        let groups: [Group]
      }
      let saved: [ChatPermissionGrant] = try await client.request(
        "/api/user-permission-grants/apply-batch", method: "PUT",
        body: JSONEncoder().encode(Body(agentId: action.agentID, groups: groups)))
      guard
        groups.allSatisfy({ group in
          group.grants.allSatisfy { requested in
            saved.contains {
              UUID(uuidString: $0.agentId) == UUID(uuidString: action.agentID)
                && $0.connectorSlug == group.connectorSlug && $0.permission == requested.permission
                && $0.action == .allow && $0.isActive(at: .now)
            }
          }
        })
      else { throw APIClientError.invalidResponse }
    }
    try Task.checkCancellation()
    let updated = try await load(action)
    guard updated.allAllowed else { throw APIClientError.invalidResponse }
    return updated
  }
}
