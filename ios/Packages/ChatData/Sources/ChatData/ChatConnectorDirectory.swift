import ChatDomain
import Foundation

public struct ChatCatalogConnector: Decodable, Identifiable, Sendable {
  public let slug: String
  public let label: String
  public let description: String
  public let category: String
  public let authMethods: [ChatConnectorMethod]
  public let permissionSummary: PermissionSummary
  public let icon: ChatConnectorIcon?
  public var id: String { slug }
  public struct PermissionSummary: Decodable, Sendable { public let hasPermissions: Bool }
}

public struct ChatConnectorDiscovery: Decodable, Sendable {
  public let connectors: [ChatCatalogConnector]
  public let totalConnectorCount: Int
  public let categoryConnectorCounts: [String: Int]?
}

public struct ChatConnectorPermissionState: Sendable {
  public let metadata: ChatPermissionMetadata
  public let grants: [ChatPermissionRule]
}

public struct ChatPermissionEdit: Encodable, Sendable {
  public let permission: String
  public let action: String
  public let expiresIn: String?
  public init(permission: String, action: String, expiresIn: String? = nil) {
    self.permission = permission
    self.action = action
    self.expiresIn = action == "allow" ? expiresIn : nil
  }
}

extension ChatComposerAccess {
  public var desktopDownloadURL: URL {
    client.baseURL.appending(path: "api/desktop/updates/stable/darwin/arm64/dmg")
  }

  public func validate(agentID _: String?, threadID: String?) async throws {
    if let threadID {
      let metadata: ThreadMetadata = try await client.request(
        "/api/chat-threads/\(threadID)/metadata")
      guard metadata.id.lowercased() == threadID.lowercased() else {
        throw APIClientError.http(
          status: 409, message: "This chat is unavailable.")
      }
    }
  }

  public func discover(keyword: String = "", category: String? = nil) async throws
    -> ChatConnectorDiscovery
  {
    var query: [URLQueryItem] = []
    let search = keyword.trimmingCharacters(in: .ecmaScriptWhitespace)
    if !search.isEmpty {
      query.append(URLQueryItem(name: "keyword", value: search))
    } else if let category, !category.isEmpty {
      query.append(URLQueryItem(name: "category", value: category))
    }
    return try await client.request("/api/connector-catalog/discovery", query: query)
  }

  public func customConnectors() async throws -> [ChatCustomConnector] {
    struct Response: Decodable, Sendable { let connectors: [ChatCustomConnector] }
    let result: Response = try await client.request("/api/custom-connectors")
    return result.connectors
  }

  public func permissions(slug: String) async throws -> ChatConnectorPermissionState {
    let result = try await ChatPermissions(client: client).connectorPermissions(slug: slug)
    guard let metadata = result.metadata else {
      throw APIClientError.http(
        status: 404, message: "Connector permission metadata is unavailable.")
    }
    return ChatConnectorPermissionState(metadata: metadata, grants: result.grants)
  }

  public func savePermissions(
    slug: String, edits: [ChatPermissionEdit], reset: Bool = false
  ) async throws {
    _ = try await ChatPermissions(client: client).applyConnectorPermissions(
      slug: slug, edits: edits, reset: reset)
  }
}
