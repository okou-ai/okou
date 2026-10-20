import Foundation

/// Ephemeral public activity, never part of the durable transcript or run lifecycle.
public struct ChatActivitySummary: Decodable, Equatable, Sendable {
  public struct Message: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let text: String
  }

  public enum Status: String, Decodable, Sendable {
    case available, ineligible, unavailable
  }

  public let runId: String
  public let messages: [Message]
  public let status: Status
}

extension APIClient {
  public func activitySummary(threadID: String, runID: String) async throws -> ChatActivitySummary {
    struct Demand: Encodable { let runId: String }
    let response: ChatActivitySummary = try await request(
      "/api/chat-threads/\(threadID)/activity-summary", method: "POST",
      body: JSONEncoder().encode(Demand(runId: runID)))
    guard response.runId == runID, UUID(uuidString: response.runId) != nil,
      response.messages.count <= 4,
      response.messages.allSatisfy({ !$0.id.isEmpty && !$0.text.isEmpty })
    else { throw APIClientError.incompatibleData }
    return response
  }
}
