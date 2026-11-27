import Foundation

public struct ComposerWorkflow: Decodable, Equatable, Identifiable, Sendable {
  public let id: String
  public let name: String
  public let displayName: String?
  public let description: String?
}

/// `nil` is a history that was never initialized; `[]` is an initialized empty history.
private struct RecentWorkflowIDs: Decodable, Sendable { let workflowIds: [String]? }
private struct SavedWorkflowIDs: Codable, Sendable { let workflowIds: [String] }

extension APIClient {
  public func composerWorkflows() async throws -> [ComposerWorkflow] {
    try await request("/api/workflows/for-composer")
  }

  /// The member's canonical recently used Workflow order, shared by every device.
  public func recentComposerWorkflowIDs() async throws -> [String]? {
    try await request("/api/workflows/recent", as: RecentWorkflowIDs.self).workflowIds
  }

  /// Moves accepted uses to the front and returns the canonical order.
  public func recordComposerWorkflowUse(_ ids: [String]) async throws -> [String] {
    try await request(
      "/api/workflows/recent/use", method: "POST",
      body: JSONEncoder().encode(SavedWorkflowIDs(workflowIds: ids)), as: SavedWorkflowIDs.self
    ).workflowIds
  }

  /// Device history initializes only a never-initialized server history.
  public func importComposerWorkflowHistory(_ ids: [String]) async throws -> [String] {
    try await request(
      "/api/workflows/recent/import", method: "POST",
      body: JSONEncoder().encode(SavedWorkflowIDs(workflowIds: ids)), as: SavedWorkflowIDs.self
    ).workflowIds
  }
}
