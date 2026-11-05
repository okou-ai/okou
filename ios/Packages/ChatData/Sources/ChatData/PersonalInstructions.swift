import Foundation

/// The authenticated member's saved Instructions. Ownership is never a request parameter.
public struct PersonalInstructions: Codable, Equatable, Sendable {
  public let orgId: String
  public let userId: String
  public let content: String
  public let updatedAt: Date
  public let version: String
}

public struct PersonalInstructionsClient: Sendable {
  private let client: APIClient

  public init(client: APIClient) { self.client = client }

  public func load() async throws -> PersonalInstructions {
    try await client.request("/api/instructions")
  }

  public func save(content: String, ifVersion: String) async throws -> PersonalInstructions {
    struct Body: Encodable {
      let content: String
      let ifVersion: String
    }
    return try await client.request(
      "/api/instructions", method: "PUT",
      body: JSONEncoder().encode(Body(content: content, ifVersion: ifVersion)))
  }
}
