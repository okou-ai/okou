import ChatDomain
import Foundation

extension ChatSync {
  public func searchMessages(keyword: String) async throws -> [ChatSearchResult] {
    struct Response: Decodable { let results: [ChatSearchResult] }
    let response: Response = try await client.request(
      "/api/chat/search", query: [URLQueryItem(name: "keyword", value: keyword)])
    return response.results
  }

  /// The workspace's workflows the person can see, without Okou's built-in ones — the list the
  /// web's search filters by name and description.
  public func searchWorkflows() async throws -> [ChatSearchWorkflow] {
    let workflows: [ChatSearchWorkflow] = try await client.request("/api/workflows")
    return workflows.filter { $0.official == nil }
  }

  /// The workspace's results (sites, files, images, decks) whose title matches, as the web's
  /// search asks the artifact catalog. Shared conversations are left out: the app cannot open them.
  public func searchArtifacts(keyword: String) async throws -> [ChatSearchArtifact] {
    struct Response: Decodable { let artifacts: [ChatSearchArtifact] }
    let response: Response = try await client.request(
      "/api/artifacts/catalog",
      query: [
        URLQueryItem(name: "keyword", value: keyword),
        URLQueryItem(name: "limit", value: String(ChatSearchArtifact.searchLimit))
      ])
    return response.artifacts.filter { $0.kind != "shared-thread" }
  }
}

/// A workflow in workspace search: what to show and its `/name` command.
public struct ChatSearchWorkflow: Decodable, Equatable, Identifiable, Sendable {
  public struct Official: Decodable, Equatable, Sendable {}
  public let id: String
  public let name: String
  public let displayName: String?
  public let description: String?
  /// Present on Okou's built-in workflows, which search leaves out as the web does.
  public let official: Official?

  public init(
    id: String, name: String, displayName: String? = nil,
    description: String? = nil
  ) {
    self.id = id
    self.name = name
    self.displayName = displayName
    self.description = description
    self.official = nil
  }

  public var title: String { displayName ?? name }

  public func matches(_ keyword: String) -> Bool {
    keyword.isEmpty
      || [displayName, name, description].contains { $0?.lowercased().contains(keyword) == true }
  }
}

/// A result from the artifact catalog in workspace search.
public struct ChatSearchArtifact: Decodable, Equatable, Identifiable, Sendable {
  public struct Thumbnail: Decodable, Equatable, Sendable { public let url: String }
  /// As many as the web's search shows.
  public static let searchLimit = 25
  public let id: String
  /// `file`, `hosted-site`, `image`, `avatar` or `presentation`.
  public let kind: String
  public let title: String
  public let thumbnail: Thumbnail?
  public let sourceUrl: String?
  public let aliasUrl: String?

  public init(
    id: String, kind: String, title: String, thumbnail: Thumbnail? = nil, sourceUrl: String? = nil,
    aliasUrl: String? = nil
  ) {
    self.id = id
    self.kind = kind
    self.title = title
    self.thumbnail = thumbnail
    self.sourceUrl = sourceUrl
    self.aliasUrl = aliasUrl
  }
}
