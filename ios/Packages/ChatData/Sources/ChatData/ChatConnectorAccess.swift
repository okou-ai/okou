import Foundation

public struct ChatConnectorAccountDefault: Decodable, Identifiable, Sendable {
  public let connectionId: String
  public let displayName: String?
  public let defaultEnabled: Bool
  public let isDefault: Bool
  public var id: String { connectionId }
}

public struct ChatConnectorAccess: Decodable, Sendable {
  public struct Account: Decodable, Identifiable, Sendable {
    public let connectionId: String
    public let displayName: String?
    public let defaultEnabled: Bool
    public let isDefault: Bool
    public let overrideEnabled: Bool?
    public let enabled: Bool
    public var id: String { connectionId }
  }
  public let target: ChatConnectorTarget
  public let accounts: [Account]
  public let currentConnectionId: String?
  public let available: Bool
  public var enabledCount: Int { accounts.filter(\.enabled).count }

  public func pending(
    overrides: [ChatConnectorAccessOverride], selections: [ChatConnectorSelection]
  ) -> Self {
    let values = accounts.map { account in
      let enabled = overrides.first {
        $0.target == target && $0.connectionId == account.connectionId
      }?.enabled
      return Account(
        connectionId: account.connectionId, displayName: account.displayName,
        defaultEnabled: account.defaultEnabled, isDefault: account.isDefault,
        overrideEnabled: enabled, enabled: enabled ?? account.defaultEnabled)
    }
    let selected = selections.first { $0.target == target }?.connectionId
    let current =
      values.first { $0.connectionId == selected && $0.enabled }
      ?? values.first { $0.isDefault && $0.enabled } ?? values.first { $0.enabled }
    return Self(
      target: target, accounts: values, currentConnectionId: current?.connectionId,
      available: current != nil)
  }
}

public struct ChatConnectorAccessOverride: Codable, Equatable, Sendable {
  public let target: ChatConnectorTarget
  public let connectionId: String
  public let enabled: Bool
  public init(target: ChatConnectorTarget, connectionId: String, enabled: Bool) {
    self.target = target
    self.connectionId = connectionId
    self.enabled = enabled
  }
}

extension ChatComposerAccess {
  public func chatAccountAccessEnabled() async throws -> Bool {
    let features: SidebarFeatureSwitches = try await client.request("/api/feature-switches")
    return features.effectiveSwitches["connectorChatAccountAccess"] == true
  }

  public func accountDefaults(target: ChatConnectorTarget) async throws
    -> [ChatConnectorAccountDefault]
  {
    try await client.request("/api/connector-account-access/defaults", query: target.query)
  }

  public func connectorAccess(
    target: ChatConnectorTarget, threadID: String?, options: ChatComposerOptions = .init()
  ) async throws -> ChatConnectorAccess {
    if let threadID {
      let value: ChatConnectorAccess = try await client.request(
        "/api/chat-threads/\(threadID)/connector-access", query: target.query)
      guard value.target == target else { throw APIClientError.invalidResponse }
      return value
    }
    let defaults = try await accountDefaults(target: target)
    return ChatConnectorAccess(
      target: target,
      accounts: defaults.map {
        ChatConnectorAccess.Account(
          connectionId: $0.connectionId, displayName: $0.displayName,
          defaultEnabled: $0.defaultEnabled, isDefault: $0.isDefault,
          overrideEnabled: nil, enabled: $0.defaultEnabled)
      }, currentConnectionId: nil, available: false
    ).pending(
      overrides: options.initialConnectorAccessOverrides, selections: options.connectorSelections)
  }

  public func setConnectorAccess(
    target: ChatConnectorTarget, connectionID: String, threadID: String, enabled: Bool?
  ) async throws {
    struct Body: Encodable {
      let target: ChatConnectorTarget
      let enabled: Bool?
      enum CodingKeys: String, CodingKey { case target, enabled }
      func encode(to encoder: any Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(target, forKey: .target)
        try values.encode(enabled, forKey: .enabled)
      }
    }
    try await client.data(
      "/api/chat-threads/\(threadID)/connector-access/\(connectionID)", method: "PUT",
      body: JSONEncoder().encode(Body(target: target, enabled: enabled)))
  }

  public func setCurrentAccount(
    target: ChatConnectorTarget, connectionID: String, threadID: String
  ) async throws {
    try await client.data(
      "/api/chat-threads/\(threadID)/connector-current", method: "PUT",
      body: JSONEncoder().encode(ChatConnectorSelection(target: target, connectionId: connectionID))
    )
  }

  public func setDefaultEnabled(
    target: ChatConnectorTarget, connectionID: String, enabled: Bool
  ) async throws {
    struct Body: Encodable {
      let target: ChatConnectorTarget
      let enabled: Bool
    }
    try await client.data(
      "/api/connector-account-access/\(connectionID)/default-enabled", method: "PUT",
      body: JSONEncoder().encode(Body(target: target, enabled: enabled)))
  }

  public func setDefaultAccount(target: ChatConnectorTarget, connectionID: String) async throws {
    struct Body: Encodable { let target: ChatConnectorTarget }
    try await client.data(
      "/api/connector-accounts/\(connectionID)/default", method: "POST",
      body: JSONEncoder().encode(Body(target: target)))
  }
}
