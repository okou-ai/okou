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

/// Reviews and applies the member's permission rules for the requested connectors.
public struct ChatBatchPermissions: Sendable {
  private let client: APIClient
  public init(client: APIClient) { self.client = client }

  public func load(
    _ action: ChatPermissionBatchAction
  ) async throws -> ChatPermissionBatchSnapshot {
    let features: SidebarFeatureSwitches = try await client.request("/api/feature-switches")
    guard features.effectiveSwitches["batchConnectorPermissions"] == true else {
      return ChatPermissionBatchSnapshot(enabled: false, agentName: nil, groups: [])
    }
    try await validateContext(action)
    return try await ChatPermissionBatchSnapshot(
      enabled: true, agentName: nil, groups: loadGroups(action))
  }

  private func loadGroups(
    _ action: ChatPermissionBatchAction, reviewing reviewed: ChatPermissionBatchSnapshot? = nil
  ) async throws -> [ChatPermissionBatchSnapshot.Group] {
    let permissions = ChatPermissions(client: client)
    let slugs = Set(action.items.map(\.connectorSlug))
    return try await withThrowingTaskGroup(
      of: ChatPermissionBatchSnapshot.Group.self
    ) { tasks in
      for slug in slugs {
        tasks.addTask {
          async let rules = permissions.connectorGrants(slug: slug)
          let metadata: ChatPermissionMetadata?
          if let reviewed {
            metadata = reviewed.groups.first { $0.connectorSlug == slug }?.metadata
          } else {
            metadata = try await permissions.metadata(slug: slug)
          }
          return try await ChatPermissionBatchSnapshot.Group(
            connectorSlug: slug, items: action.items.filter { $0.connectorSlug == slug },
            metadata: metadata, grants: rules)
        }
      }
      var result: [ChatPermissionBatchSnapshot.Group] = []
      for try await group in tasks { result.append(group) }
      return result.sorted { $0.connectorSlug < $1.connectorSlug }
    }
  }

  public func validateContext(_ action: ChatPermissionBatchAction) async throws {
    let thread: ThreadMetadata = try await client.request(
      "/api/chat-threads/\(action.threadID)/metadata")
    guard UUID(uuidString: thread.id) == UUID(uuidString: action.threadID)
    else { throw ChatError.invalidContract("This request no longer belongs to this chat.") }
  }

  public func apply(
    _ action: ChatPermissionBatchAction, duration: ChatPermissionAction.Duration,
    reviewing reviewed: ChatPermissionBatchSnapshot
  ) async throws -> ChatPermissionBatchSnapshot {
    async let context: Void = validateContext(action)
    let features: SidebarFeatureSwitches = try await client.request("/api/feature-switches")
    guard features.effectiveSwitches["batchConnectorPermissions"] == true else {
      throw ChatError.invalidContract("These permissions are no longer available.")
    }
    // Fresh rules preserve existing expirations. The write endpoint validates its current catalog.
    let current = try await ChatPermissionBatchSnapshot(
      enabled: true, agentName: reviewed.agentName, groups: loadGroups(action, reviewing: reviewed))
    try await context
    guard current.complete else {
      throw ChatError.invalidContract("These permissions are no longer available.")
    }
    try Task.checkCancellation()
    if current.allAllowed { return current }
    let permissions = ChatPermissions(client: client)
    var groups: [ChatPermissionBatchSnapshot.Group] = []
    // A write can partially succeed across connectors. The owner reads back on failure.
    for group in current.groups {
      let missing = group.items.filter { !group.allows($0) }
      if missing.isEmpty {
        groups.append(group)
        continue
      }
      try Task.checkCancellation()
      let saved = try await permissions.applyConnectorPermissions(
        slug: group.connectorSlug,
        edits: missing.map {
          ChatPermissionEdit(
            permission: $0.permission, action: "allow", expiresIn: duration.rawValue)
        })
      guard
        missing.allSatisfy({ requested in
          saved.contains {
            $0.permission == requested.permission && $0.action == .allow && $0.isActive(at: .now)
          }
        })
      else { throw APIClientError.invalidResponse }
      groups.append(
        ChatPermissionBatchSnapshot.Group(
          connectorSlug: group.connectorSlug, items: group.items, metadata: group.metadata,
          grants: saved))
    }
    try Task.checkCancellation()
    let updated = ChatPermissionBatchSnapshot(
      enabled: current.enabled, agentName: current.agentName, groups: groups)
    guard updated.allAllowed else { throw APIClientError.invalidResponse }
    return updated
  }
}
