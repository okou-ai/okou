import Foundation

public struct ComposerWorkflow: Decodable, Equatable, Identifiable, Sendable {
  public let id: String
  public let name: String
  public let displayName: String?
  public let description: String?
}

extension APIClient {
  public func composerWorkflows() async throws -> [ComposerWorkflow] {
    try await request("/api/workflows/for-composer")
  }
}
