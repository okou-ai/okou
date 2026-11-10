import Foundation

public struct ChatProject: Codable, Equatable, Identifiable, Sendable {
  public let id: String
  public let name: String
  public let createdAt: Date
  public let updatedAt: Date
}

/// Canonical Project operations share the authenticated workspace transport.
public struct ChatProjects: Sendable {
  private let client: APIClient

  public init(client: APIClient) { self.client = client }

  public func list() async throws -> [ChatProject] {
    let response: ProjectList = try await client.request("/api/projects")
    return response.projects
  }

  public func create(name: String, eventID: String, fromThreadID: String? = nil) async throws
    -> ChatProject
  {
    try await client.request(
      "/api/projects", method: "POST",
      body: JSONEncoder().encode(
        CreateProject(id: eventID, eventId: eventID, name: name, fromThreadId: fromThreadID)))
  }

  public func rename(_ id: String, name: String, eventID: String) async throws -> ChatProject {
    try await client.request(
      "/api/projects/\(id)", method: "PATCH",
      body: JSONEncoder().encode(RenameProject(eventId: eventID, name: name)))
  }

  public func delete(_ id: String, eventID: String) async throws {
    try await client.data(
      "/api/projects/\(id)", method: "DELETE",
      body: JSONEncoder().encode(["eventId": eventID]))
  }

  public func move(threadID: String, projectID: String?, eventID: String) async throws {
    try await client.data(
      "/api/chat-threads/\(threadID)/project", method: "PUT",
      body: JSONEncoder().encode(Membership(eventId: eventID, projectId: projectID)))
  }

  /// The API requires time-bound UUIDv7 operation identities for explicit retries.
  public static func operationID(now: Date = .now) -> String {
    let milliseconds = UInt64(now.timeIntervalSince1970 * 1000)
    let time = String(format: "%012llx", milliseconds)
    let random = UUID().uuidString.lowercased()
    return
      "\(time.prefix(8))-\(time.suffix(4))-7\(random.dropFirst(15).prefix(3))-\(random.dropFirst(19))"
  }

  private struct ProjectList: Decodable, Sendable { let projects: [ChatProject] }
  private struct CreateProject: Encodable {
    let id: String
    let eventId: String
    let name: String
    let fromThreadId: String?
  }
  private struct RenameProject: Encodable {
    let eventId: String
    let name: String
  }
  private struct Membership: Encodable {
    let eventId: String
    let projectId: String?

    enum CodingKeys: CodingKey { case eventId, projectId }

    func encode(to encoder: Encoder) throws {
      var container = encoder.container(keyedBy: CodingKeys.self)
      try container.encode(eventId, forKey: .eventId)
      try container.encode(projectId, forKey: .projectId)
    }
  }
}
