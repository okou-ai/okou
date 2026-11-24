import Foundation

public struct ChatConnectorDeletionImpact: Decodable, Sendable {
  public let connectionId: String
  public let explicitSelectionCount: Int
  public let hasSibling: Bool
}

extension ChatComposerAccess {
  public func catalogConnector(slug: String) async throws -> ChatCatalogConnector {
    struct Response: Decodable, Sendable { let connector: ChatCatalogConnector }
    let result: Response = try await client.request("/api/connector-catalog/\(slug)")
    guard result.connector.slug == slug else { throw APIClientError.invalidResponse }
    return result.connector
  }

  /// Inspect every saved account, including accounts disabled by default.
  public func managedConnectors(memberAccess: Bool = false) async throws -> [ChatComposerConnector]
  {
    struct Inspection: Decodable, Sendable {
      let kind: String
      let connectionId: String
      let target: ChatConnectorTarget
      let connectionStatus: String?
    }
    struct Body: Encodable { let selections: [ChatConnectorSelection] }
    struct Response: Decodable, Sendable { let results: [Inspection] }
    var connectors = try await connectors(memberAccess: memberAccess).filter {
      $0.target.kind == "builtin"
    }
    let selections = connectors.flatMap { connector in
      connector.access.accounts.map {
        ChatConnectorSelection(target: connector.target, connectionId: $0.connectionId)
      }
    }
    var reconnect = Set<String>()
    for offset in stride(from: 0, to: selections.count, by: 256) {
      let batch = Array(selections[offset..<min(offset + 256, selections.count)])
      let result: Response = try await client.request(
        "/api/connector-accounts/inspect", method: "POST",
        body: JSONEncoder().encode(Body(selections: batch)))
      guard result.results.count == batch.count,
        Set(result.results.map(\.connectionId)).count == batch.count,
        result.results.allSatisfy({ item in
          batch.contains { $0.connectionId == item.connectionId && $0.target == item.target }
            && (item.kind == "unavailable"
              || (item.kind == "available" && item.connectionStatus != nil))
        })
      else { throw APIClientError.invalidResponse }
      reconnect.formUnion(
        result.results.filter {
          $0.kind == "available" && $0.connectionStatus == "reconnect-required"
        }.map(\.connectionId))
    }
    for index in connectors.indices {
      connectors[index].reconnectAccountIDs = connectors[index].access.accounts.compactMap {
        reconnect.contains($0.connectionId) ? $0.connectionId : nil
      }
    }
    return connectors
  }

  public func renameAccount(
    target: ChatConnectorTarget, connectionID: String, displayName: String?
  ) async throws {
    struct Body: Encodable {
      let target: ChatConnectorTarget
      let displayName: String?
      enum CodingKeys: CodingKey { case target, displayName }
      func encode(to encoder: any Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(target, forKey: .target)
        try values.encode(displayName, forKey: .displayName)
      }
    }
    let result: ChatConnectorAccount = try await client.request(
      "/api/connector-accounts/\(connectionID)", method: "PATCH",
      body: JSONEncoder().encode(Body(target: target, displayName: displayName)))
    guard result.id == connectionID, result.target == target else {
      throw APIClientError.invalidResponse
    }
  }

  public func deletionImpact(target: ChatConnectorTarget, connectionID: String) async throws
    -> ChatConnectorDeletionImpact
  {
    let result: ChatConnectorDeletionImpact = try await client.request(
      "/api/connector-accounts/\(connectionID)/deletion-impact", query: target.query)
    guard result.connectionId == connectionID else { throw APIClientError.invalidResponse }
    return result
  }

  public func disconnectAccount(target: ChatConnectorTarget, connectionID: String) async throws {
    struct Body: Encodable { let target: ChatConnectorTarget }
    struct Response: Decodable, Sendable { let deletedConnectionId: String }
    let result: Response = try await client.request(
      "/api/connector-accounts/\(connectionID)", method: "DELETE",
      body: JSONEncoder().encode(Body(target: target)))
    guard result.deletedConnectionId == connectionID else { throw APIClientError.invalidResponse }
  }
}
