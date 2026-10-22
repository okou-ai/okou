import Foundation

public struct ComposerWorkflow: Decodable, Equatable, Identifiable, Sendable {
  public let id: String
  public let name: String
  public let displayName: String?
  public let description: String?
}

extension APIClient {
  /// The API owns Agent availability, access checks, and Workflow filtering.
  public func composerWorkflows(agentID: String) async throws -> [ComposerWorkflow] {
    try await request(
      "/api/workflows/for-composer", query: [URLQueryItem(name: "agentId", value: agentID)])
  }
}
