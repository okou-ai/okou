import ChatDomain
import Foundation

public struct ChatComputerAccess: Codable, Equatable, Sendable {
  public var computerUseHostId: String?
  public var cloudBrowserEnabled: Bool
  public init(computerUseHostId: String? = nil, cloudBrowserEnabled: Bool = false) {
    self.computerUseHostId = computerUseHostId
    self.cloudBrowserEnabled = cloudBrowserEnabled
  }
}

public struct ChatConnectorSelection: Codable, Equatable, Sendable {
  public let target: ChatConnectorTarget
  public let connectionId: String
  public init(target: ChatConnectorTarget, connectionId: String) {
    self.target = target
    self.connectionId = connectionId
  }
}

public enum ChatRemoteProtocol: String, Codable, CaseIterable, Sendable {
  case ssh, vnc
}

public struct ChatRemoteOverride: Codable, Equatable, Sendable {
  public let `protocol`: ChatRemoteProtocol
  public let connectionId: String
  public let enabled: Bool
  public init(protocol: ChatRemoteProtocol, connectionId: String, enabled: Bool) {
    self.protocol = `protocol`
    self.connectionId = connectionId
    self.enabled = enabled
  }
}

/// New-chat choices are carried by the owning composer until its first send.
public struct ChatComposerOptions: Codable, Equatable, Sendable {
  public var connectorSelections: [ChatConnectorSelection] = []
  public var initialConnectorAccessOverrides: [ChatConnectorAccessOverride] = []
  public var initialRemoteAccessOverrides: [ChatRemoteOverride] = []
  public var computerAccess: ChatComputerAccess?
  public init() {}
}

public struct ChatComposerConnector: Identifiable, Sendable {
  public let target: ChatConnectorTarget
  public let label: String
  public let hasPermissions: Bool
  /// The partner's own logo; custom connectors have none.
  public var icon: ChatConnectorIcon?
  public var access: ChatConnectorAccess
  public var currentAccount: ChatConnectorAccount?
  public var id: String { target.key }
}

/// A connector logo as the catalog publishes it: an https image, inverted in dark mode
/// when it is a single-colour mark, optionally scaled inside its square slot.
public struct ChatConnectorIcon: Decodable, Equatable, Sendable {
  public let url: URL
  public let invertInDarkMode: Bool
  public let scale: Double?
}

extension ChatConnectorTarget {
  public var key: String { kind + ":" + (connectorSlug ?? customConnectorId ?? "") }
}

public struct ChatRemoteHost: Decodable, Identifiable, Sendable {
  public let connectionId: String
  public let displayName: String
  public let defaultEnabled: Bool
  public let overrideEnabled: Bool?
  public let enabled: Bool?
  public var id: String { connectionId }
}

public struct ChatThreadRemoteAccess: Decodable, Sendable {
  public let ssh: [ChatRemoteHost]
  public let vnc: [ChatRemoteHost]
}

public struct ChatComputerHost: Decodable, Identifiable, Sendable {
  public let id: String
  public let displayName: String
  public let status: String
}

public struct ChatRemotesOverview: Decodable, Sendable {
  public let computerUseHosts: [ChatComputerHost]
  public let cloudBrowserAvailable: Bool
  public let cloudBrowserEnabledByDefault: Bool
  public let sshHosts: [ChatRemoteHost]
  public let vncHosts: [ChatRemoteHost]
}

public struct ChatConnectorAccounts: Decodable, Sendable {
  public let connections: [ChatConnectorAccount]
  public let nextCursor: String?
  public let defaultConnection: ChatConnectorAccount?

  private enum CodingKeys: String, CodingKey { case connections, nextCursor, defaultConnection }

  public init(from decoder: any Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    connections = try values.decode([ChatConnectorAccount].self, forKey: .connections)
    nextCursor = try values.decode(String?.self, forKey: .nextCursor)
    defaultConnection = try values.decode(ChatConnectorAccount?.self, forKey: .defaultConnection)
  }
}

public struct ChatVncConnection: Decodable, Sendable {
  public let id: String
  public let transport: Transport?
  public let security: Security
  public struct Transport: Decodable, Sendable {
    public let type: String
    public let connectionId: String?
  }
  public struct Security: Decodable, Sendable {
    public let kdc: Kdc?
  }
  public struct Kdc: Decodable, Sendable { public let transport: Transport }
  public var sshDependencies: [String] {
    Array(
      Set(
        [transport, security.kdc?.transport].compactMap {
          $0?.type == "ssh" ? $0?.connectionId : nil
        })
    ).sorted()
  }
}

/// User-session controls for accounts and access in the composer.
public struct ChatComposerAccess: Sendable {
  let client: APIClient
  public init(client: APIClient) { self.client = client }

  public func connectors(
    threadID: String? = nil, options: ChatComposerOptions = .init()
  ) async throws -> [ChatComposerConnector] {
    struct Builtin: Decodable, Sendable {
      let slug: String
      let label: String
      let hasPermissions: Bool
      let icon: ChatConnectorIcon?
    }
    struct Custom: Decodable, Sendable {
      let id: String
      let displayName: String
    }
    struct Connected: Decodable, Sendable {
      let builtinConnectors: [Builtin]
      let customConnectors: [Custom]
    }
    struct Candidate: Sendable {
      let target: ChatConnectorTarget
      let label: String
      let hasPermissions: Bool
      let icon: ChatConnectorIcon?
    }
    let list: Connected = try await client.request("/api/connectors/connected")
    let candidates =
      list.builtinConnectors.map {
        Candidate(
          target: .builtin($0.slug), label: $0.label, hasPermissions: $0.hasPermissions,
          icon: $0.icon)
      }
      + list.customConnectors.map {
        Candidate(target: .custom($0.id), label: $0.displayName, hasPermissions: false, icon: nil)
      }
    return try await withThrowingTaskGroup(of: (Int, ChatComposerConnector).self) { group in
      for (index, candidate) in candidates.enumerated() {
        group.addTask {
          let access = try await self.connectorAccess(
            target: candidate.target, threadID: threadID, options: options)
          var currentAccount: ChatConnectorAccount?
          if let id = access.currentConnectionId {
            do {
              currentAccount = try await ChatConnectorService(client: self.client).account(
                id: id, target: candidate.target)
            } catch let error as APIClientError where error.statusCode == 404 {
              currentAccount = nil
            }
          }
          return (
            index,
            ChatComposerConnector(
              target: candidate.target, label: candidate.label,
              hasPermissions: candidate.hasPermissions, icon: candidate.icon, access: access,
              currentAccount: currentAccount)
          )
        }
      }
      var result: [(Int, ChatComposerConnector)] = []
      for try await value in group { result.append(value) }
      return result.sorted { $0.0 < $1.0 }.map { $0.1 }
    }
  }

  public func remotes() async throws -> ChatRemotesOverview {
    try await client.request("/api/remotes/overview")
  }
  public func remoteAccess(threadID: String) async throws -> ChatThreadRemoteAccess {
    try await client.request("/api/chat-threads/\(threadID)/remote-access")
  }
  public func vncConnections() async throws -> [ChatVncConnection] {
    struct Response: Decodable, Sendable { let connections: [ChatVncConnection] }
    let response: Response = try await client.request("/api/vnc/connections")
    return response.connections
  }
  public func setRemote(
    threadID: String, protocol: ChatRemoteProtocol, connectionID: String, enabled: Bool?
  ) async throws {
    struct Body: Encodable { let enabled: Bool }
    if let enabled {
      try await client.data(
        "/api/chat-threads/\(threadID)/remote-access/\(`protocol`.rawValue)/\(connectionID)",
        method: "PUT", body: JSONEncoder().encode(Body(enabled: enabled)))
    } else {
      try await client.data(
        "/api/chat-threads/\(threadID)/remote-access/\(`protocol`.rawValue)/\(connectionID)",
        method: "DELETE")
    }
  }
  public func computerAccess(threadID: String) async throws -> ChatComputerAccess {
    let metadata: ThreadMetadata = try await client.request(
      "/api/chat-threads/\(threadID)/metadata")
    return ChatComputerAccess(
      computerUseHostId: metadata.computerUseHostId,
      cloudBrowserEnabled: metadata.cloudBrowserEnabled)
  }
  public func setComputerAccess(_ access: ChatComputerAccess, threadID: String) async throws {
    struct Body: Encodable {
      let computerUseHostId: String?
      let cloudBrowserEnabled: Bool
      enum CodingKeys: String, CodingKey { case computerUseHostId, cloudBrowserEnabled }
      func encode(to encoder: any Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(computerUseHostId, forKey: .computerUseHostId)
        try values.encode(cloudBrowserEnabled, forKey: .cloudBrowserEnabled)
      }
    }
    try await client.data(
      "/api/chat-threads/\(threadID)/computer-use-host", method: "POST",
      body: JSONEncoder().encode(
        Body(
          computerUseHostId: access.computerUseHostId,
          cloudBrowserEnabled: access.cloudBrowserEnabled)))
  }
  public func accounts(
    target: ChatConnectorTarget, search: String = "", cursor: String? = nil
  ) async throws -> ChatConnectorAccounts {
    var query = target.query + [URLQueryItem(name: "limit", value: "50")]
    let term = String(search.unicodeScalars.drop(while: CharacterSet.ecmaScriptWhitespace.contains))
    if !term.isEmpty { query.append(URLQueryItem(name: "search", value: term)) }
    if let cursor, !cursor.isEmpty { query.append(URLQueryItem(name: "cursor", value: cursor)) }
    let response: ChatConnectorAccounts = try await client.request(
      "/api/connector-accounts/connections", query: query)
    guard response.connections.allSatisfy({ $0.target == target }),
      response.defaultConnection.map({ $0.target == target }) ?? true
    else {
      throw APIClientError.invalidResponse
    }
    return response
  }
}
