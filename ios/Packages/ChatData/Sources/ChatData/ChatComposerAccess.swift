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
  public var initialRemoteAccessOverrides: [ChatRemoteOverride] = []
  public var computerAccess: ChatComputerAccess?
  public init() {}
}

public struct ChatComposerConnector: Identifiable, Sendable {
  public let target: ChatConnectorTarget
  public let label: String
  public let hasPermissions: Bool
  public let permissionBundleRef: String?
  public let managed: Bool
  public let authorized: Bool
  public var id: String { target.key }
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
}

public struct ChatConnectorPreferences: Decodable, Sendable {
  public let selections: [ChatConnectorSelection]
  public let selectedConnections: [ChatConnectorAccount]
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

/// User-session controls share the PWA's Agent and conversation scopes.
public struct ChatComposerAccess: Sendable {
  let client: APIClient
  public init(client: APIClient) { self.client = client }

  public func connectors(agentID: String) async throws -> [ChatComposerConnector] {
    struct Builtin: Decodable, Sendable {
      let slug: String
      let label: String
      let hasPermissions: Bool
    }
    struct Custom: Decodable, Sendable {
      let id: String
      let displayName: String
      let permissionBundleRef: String?
      let integrationManaged: Bool
    }
    struct Connected: Decodable, Sendable {
      let builtinConnectors: [Builtin]
      let customConnectors: [Custom]
    }
    struct Access: Decodable, Sendable {
      let enabledConnectorSlugs: [String]
      let customConnectorIds: [String]
    }
    async let connected: Connected = client.request("/api/connectors/connected")
    async let access: Access = client.request("/api/agents/\(agentID)/connector-access")
    let (list, grants) = try await (connected, access)
    return list.builtinConnectors.map {
      ChatComposerConnector(
        target: .builtin($0.slug), label: $0.label, hasPermissions: $0.hasPermissions,
        permissionBundleRef: nil, managed: false,
        authorized: grants.enabledConnectorSlugs.contains($0.slug))
    }
      + list.customConnectors.map {
        ChatComposerConnector(
          target: .custom($0.id), label: $0.displayName, hasPermissions: false,
          permissionBundleRef: $0.permissionBundleRef, managed: $0.integrationManaged,
          authorized: grants.customConnectorIds.contains($0.id))
      }
  }

  public func setAuthorized(
    _ connector: ChatComposerConnector, agentID: String, enabled: Bool
  ) async throws {
    if let slug = connector.target.connectorSlug {
      struct Body: Encodable {
        let enabledConnectorSlugs: [String]
        let operation: String
      }
      try await client.data(
        "/api/agents/\(agentID)/user-connectors", method: "PUT",
        body: JSONEncoder().encode(
          Body(enabledConnectorSlugs: [slug], operation: enabled ? "add" : "remove")))
    } else if let id = connector.target.customConnectorId {
      guard !enabled || connector.permissionBundleRef == nil else {
        throw ChatError.invalidContract(
          "Configure this connector's permissions before enabling it.")
      }
      struct Grant: Encodable {
        let customConnectorId: String
        let permissionNames: [String]
      }
      struct Body: Encodable {
        let grants: [Grant]
        let operation: String
      }
      try await client.data(
        "/api/agents/\(agentID)/custom-connectors", method: "PUT",
        body: JSONEncoder().encode(
          Body(
            grants: [Grant(customConnectorId: id, permissionNames: [])],
            operation: enabled ? "add" : "remove")))
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
    try await client.data(
      "/api/chat-threads/\(threadID)/remote-access/\(`protocol`.rawValue)/\(connectionID)",
      method: enabled == nil ? "DELETE" : "PUT",
      body: try enabled.map { try JSONEncoder().encode(Body(enabled: $0)) })
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
  public func preferences(threadID: String) async throws -> ChatConnectorPreferences {
    try await client.request("/api/chat-threads/\(threadID)/connector-selections")
  }
  public func accounts(
    target: ChatConnectorTarget, search: String = "", cursor: String? = nil
  ) async throws -> ChatConnectorAccounts {
    var query = target.query + [URLQueryItem(name: "limit", value: "50")]
    if !search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      query.append(URLQueryItem(name: "search", value: search))
    }
    if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
    let response: ChatConnectorAccounts = try await client.request(
      "/api/connector-accounts/connections", query: query)
    guard response.connections.allSatisfy({ $0.target == target }),
      response.defaultConnection.map({ $0.target == target }) ?? true
    else {
      throw APIClientError.invalidResponse
    }
    return response
  }
  public func selectAccount(
    target: ChatConnectorTarget, connectionID: String?, threadID: String
  ) async throws {
    let body =
      try connectionID.map {
        try JSONEncoder().encode(ChatConnectorSelection(target: target, connectionId: $0))
      } ?? JSONEncoder().encode(target)
    try await client.data(
      "/api/chat-threads/\(threadID)/connector-selections",
      method: connectionID == nil ? "DELETE" : "PUT", body: body)
  }
}
