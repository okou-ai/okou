import Foundation

public struct ChatShareSelection: Decodable, Sendable {
  public struct Message: Decodable, Sendable {
    public let eventId: String
    public let role: String
    public let turnEventIds: [String]
  }
  public let messages: [Message]
}

public struct ChatShareVisibility: Decodable, Sendable {
  public let id: String
  public let audience: ChatShareAudience
  public let revision: String?
}

extension APIClient {
  public func chatShareSelection(threadID: String) async throws -> ChatShareSelection {
    try await request("/api/chat-threads/\(threadID)/shared-threads/selection")
  }

  public func createSelectedChatShare(
    threadID: String, eventIDs: [String], audience: ChatShareAudience, id: String
  ) async throws -> String {
    struct Demand: Encodable {
      let eventIds: [String]
      let audience: ChatShareAudience
      let id: String
    }
    struct Created: Decodable { let id: String }
    let created: Created = try await request(
      "/api/chat-threads/\(threadID)/shared-threads/selection", method: "POST",
      body: JSONEncoder().encode(Demand(eventIds: eventIDs, audience: audience, id: id)))
    return created.id
  }

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
