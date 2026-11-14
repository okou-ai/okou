import Foundation

public struct ChatShareVisibility: Decodable, Sendable {
  public let id: String
  public let audience: ChatShareAudience
  public let revision: String?

  public init(id: String, audience: ChatShareAudience, revision: String?) {
    self.id = id
    self.audience = audience
    self.revision = revision
  }
}

extension APIClient {
  public func chatShareVisibility(id: String) async throws -> ChatShareVisibility {
    try await request("/api/shared-threads/\(id)/visibility")
  }

  public func changeChatShareVisibility(
    id: String, audience: ChatShareAudience, revision: String?
  ) async throws -> ChatShareVisibility {
    struct Demand: Encodable {
      let audience: ChatShareAudience
      let expectedRevision: String?

      enum CodingKeys: CodingKey { case audience, expectedRevision }

      func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(audience, forKey: .audience)
        try container.encode(expectedRevision, forKey: .expectedRevision)
      }
    }
    return try await request(
      "/api/shared-threads/\(id)/visibility", method: "PUT",
      body: JSONEncoder().encode(Demand(audience: audience, expectedRevision: revision)))
  }
}
