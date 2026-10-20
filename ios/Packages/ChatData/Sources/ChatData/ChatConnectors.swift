import Foundation

public struct ChatConnectorAccount: Decodable, Equatable, Sendable, Identifiable {
  public let id: String
  public let target: ChatConnectorTarget
  public let authMethod: String
  public let displayName: String?
  public let externalEmail: String?
  public let externalUsername: String?
  public let externalId: String?
  public let connectionStatus: String
  public let reconnectReason: String?
  public let setupStatus: String?
  public var label: String {
    displayName ?? externalEmail ?? externalUsername ?? externalId ?? "Account"
  }
  public var ready: Bool { connectionStatus == "connected" && setupStatus == "complete" }
}

public struct ChatConnectorMethod: Decodable, Equatable, Sendable, Identifiable {
  public let id: String
  public let label: String
  public let description: String?
  public let grantKind: String
  public let manualFields: [Field]
  public let startOptions: [StartOption]
  public struct Field: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let label: String
    public let required: Bool
    public let placeholder: String?
    public let inputType: String
  }
  public struct StartOption: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let label: String
    public let required: Bool
    public let defaultValue: String?
    public let options: [Choice]
  }
  public struct Choice: Decodable, Equatable, Sendable {
    public let value: String
    public let label: String
  }
}

public struct ChatBuiltinConnector: Decodable, Sendable {
  public let slug: String
  public let label: String
  public let description: String
  public let authMethods: [ChatConnectorMethod]
  public let connectNotice: String?
}
public struct ChatCustomConnector: Decodable, Sendable {
  public let id: String
  public let slug: String
  public let displayName: String
  public let fields: [Field]
  public let authMode: String
  public let permissionBundleRef: String?
  public let connected: Bool?
  public let oauthConfig: OAuthConfig?
  public struct OAuthConfig: Decodable, Sendable { public let providerAdapter: String }
  public struct Field: Decodable, Sendable, Identifiable {
    public let key: String
    public let label: String
    public let kind: String
    public let required: Bool
    public let description: String?
    public var id: String { key }
  }
  public var managed: Bool { oauthConfig?.providerAdapter == "feishu" }
}

public struct ChatConnectorStatus: Sendable {
  public let target: ChatConnectorTarget
  public let builtin: ChatBuiltinConnector?
  public let custom: ChatCustomConnector?
  public let account: ChatConnectorAccount?
  public let authorized: Bool
  public let selected: Bool
  public var label: String { builtin?.label ?? custom?.displayName ?? "Connector" }
  public var connected: Bool {
    custom?.managed == true ? custom?.connected == true : account?.ready == true
  }
  public var complete: Bool { connected && authorized }
}

/// Operation receipts never identify an account through a mutable default projection.
public struct ChatConnectorReceipt: Decodable, Sendable {
  public let result: String?
  public let status: String?
  public let authorizationUrl: URL?
  public let oauthAttemptId: String?
  public let connectionId: String?
  public let connectedAccountId: String?
  public let sessionId: String?
  public let sessionToken: String?
  public let userCode: String?
  public let verificationUri: URL?
  public let verificationUriComplete: URL?
  public let expiresIn: Double?
  public let interval: Double?
  public let errorMessage: String?
  public var operatedID: String {
    get throws {
      if let connectionId, let connectedAccountId, connectionId != connectedAccountId {
        throw APIClientError.invalidResponse
      }
      guard let id = connectionId ?? connectedAccountId, UUID(uuidString: id) != nil else {
        throw APIClientError.incompatibleData
      }
      return id.lowercased()
    }
  }
}

public struct ChatConnectorService: Sendable {
  private let client: APIClient
  public init(client: APIClient) { self.client = client }

  public func status(_ action: ChatConnectorAction) async throws -> ChatConnectorStatus? {
    // The thread's current Agent is authoritative, including after reassignment.
    struct Metadata: Decodable, Sendable { let agentId: String }
    do {
      let metadata: Metadata = try await client.request(
        "/api/chat-threads/\(action.threadID)/metadata")
      guard metadata.agentId.lowercased() == action.agentID.lowercased() else { return nil }
      return try await readStatus(action)
    } catch let error as APIClientError where error.statusCode == 404 { return nil }
  }

  private func readStatus(_ action: ChatConnectorAction) async throws -> ChatConnectorStatus? {
    var builtin: ChatBuiltinConnector?
    var custom: ChatCustomConnector?
    let target: ChatConnectorTarget
    var exactID: String?
    switch action.kind {
    case .unavailable: return nil
    case .connect(let slug):
      if slug.hasPrefix("_") {
        struct List: Decodable, Sendable { let connectors: [ChatCustomConnector] }
        let list: List = try await client.request("/api/custom-connectors")
        guard let connector = list.connectors.first(where: { $0.slug == slug }) else { return nil }
        guard UUID(uuidString: connector.id) != nil else { throw APIClientError.invalidResponse }
        custom = connector
        target = .custom(connector.id)
      } else {
        target = .builtin(slug)
      }
    case .reconnect(let slug, let id):
      target = .builtin(slug)
      exactID = id
    case .select(let selectedTarget, let id):
      target = selectedTarget
      exactID = id
    }
    if let slug = target.connectorSlug {
      struct Response: Decodable, Sendable { let connector: ChatBuiltinConnector }
      let response: Response = try await client.request("/api/connector-catalog/\(slug)")
      guard response.connector.slug == slug else { throw APIClientError.invalidResponse }
      builtin = response.connector
    } else if custom == nil, let id = target.customConnectorId {
      custom = try await client.request("/api/custom-connectors/\(id)")
      guard custom?.id.lowercased() == id.lowercased() else { throw APIClientError.invalidResponse }
    }
    let account: ChatConnectorAccount?
    if let exactID {
      account = try await self.account(id: exactID, target: target)
    } else if custom?.managed == true {
      account = nil
    } else {
      struct Summary: Decodable, Sendable {
        let target: ChatConnectorTarget
        let defaultConnection: ChatConnectorAccount?
      }
      struct Response: Decodable, Sendable { let summaries: [Summary] }
      let response: Response = try await client.request("/api/connector-accounts")
      account = response.summaries.first { $0.target == target }?.defaultConnection
      if let account, account.target != target { throw APIClientError.invalidResponse }
      if let account, account.setupStatus == nil { throw APIClientError.incompatibleData }
    }
    if case .reconnect = action.kind {
      guard let account,
        builtin?.authMethods.contains(where: {
          $0.id == account.authMethod && $0.grantKind != "managed"
        }) == true
      else { return nil }
    }
    if let builtin, account?.ready != true,
      !builtin.authMethods.contains(where: {
        $0.grantKind != "managed" && (account == nil || $0.id == account?.authMethod)
      })
    {
      return nil
    }
    if custom?.managed == true, custom?.connected == nil { throw APIClientError.incompatibleData }
    let authorized: Bool
    if let slug = target.connectorSlug {
      struct Response: Decodable, Sendable { let enabledConnectorSlugs: [String] }
      let response: Response = try await client.request(
        "/api/agents/\(action.agentID)/user-connectors")
      authorized = response.enabledConnectorSlugs.contains(slug)
    } else {
      struct Grant: Decodable, Sendable { let customConnectorId: String }
      struct Response: Decodable, Sendable { let grants: [Grant] }
      let response: Response = try await client.request(
        "/api/agents/\(action.agentID)/custom-connectors")
      authorized = response.grants.contains {
        $0.customConnectorId.lowercased() == target.customConnectorId?.lowercased()
      }
    }
    var selected = false
    if case .select = action.kind {
      guard authorized else { return nil }
      struct Selection: Decodable, Sendable {
        let target: ChatConnectorTarget
        let connectionId: String
      }
      struct Response: Decodable, Sendable { let selections: [Selection] }
      let response: Response = try await client.request(
        "/api/chat-threads/\(action.threadID)/connector-selections")
      selected = response.selections.contains {
        $0.target == target && $0.connectionId.lowercased() == exactID
      }
    }
    return ChatConnectorStatus(
      target: target, builtin: builtin, custom: custom, account: account, authorized: authorized,
      selected: selected)
  }

  public func account(id: String, target: ChatConnectorTarget) async throws -> ChatConnectorAccount
  {
    let account: ChatConnectorAccount = try await client.request(
      "/api/connector-accounts/\(id)", query: target.query)
    guard account.id.lowercased() == id.lowercased(), account.target == target else {
      throw APIClientError.invalidResponse
    }
    return account
  }
  public func authorize(_ action: ChatConnectorAction, status: ChatConnectorStatus) async throws {
    if let slug = status.target.connectorSlug {
      struct Body: Encodable {
        let enabledConnectorSlugs: [String]
        let operation = "add"
      }
      try await client.data(
        "/api/agents/\(action.agentID)/user-connectors", method: "PUT",
        body: JSONEncoder().encode(Body(enabledConnectorSlugs: [slug])))
    } else if let id = status.target.customConnectorId {
      guard status.custom?.permissionBundleRef == nil else {
        throw APIClientError.http(
          status: 409, message: "Authorize this connector's permissions on the web, then refresh.")
      }
      struct Grant: Encodable {
        let customConnectorId: String
        let permissionNames: [String] = []
      }
      struct Body: Encodable {
        let grants: [Grant]
        let operation = "add"
      }
      try await client.data(
        "/api/agents/\(action.agentID)/custom-connectors", method: "PUT",
        body: JSONEncoder().encode(Body(grants: [Grant(customConnectorId: id)])))
    }
  }
  public func select(_ action: ChatConnectorAction, status: ChatConnectorStatus) async throws {
    guard case .select(let target, let id) = action.kind, target == status.target else {
      throw APIClientError.invalidResponse
    }
    struct Body: Encodable {
      let target: ChatConnectorTarget
      let connectionId: String
    }
    try await client.data(
      "/api/chat-threads/\(action.threadID)/connector-selections", method: "PUT",
      body: JSONEncoder().encode(Body(target: target, connectionId: id)))
  }
  public func start(
    _ action: ChatConnectorAction, status: ChatConnectorStatus, method: ChatConnectorMethod?,
    values: [String: String], options: [String: String]
  ) async throws -> ChatConnectorReceipt {
    struct Account: Encodable {
      let intent: String
      let connectionId: String?
    }
    struct Body: Encodable {
      let account: Account
      let agentId: String
      var authorizeAgent: Bool?
      var authMethod: String?
      var values: [String: String]?
      var options: [String: String]?
    }
    let account = Account(
      intent: status.account == nil ? "add" : "reconnect", connectionId: status.account?.id)
    if let slug = status.target.connectorSlug, let method {
      let route: String
      switch method.grantKind {
      case "auth-code": route = "oauth/start"
      case "openid-auth": route = "openid/start"
      case "automatic": route = "automatic/start"
      case "none": route = "no-auth"
      case "manual": route = "manual-grant"
      case "device-auth": route = "oauth/device/sessions"
      case "external-code": route = "external-code/sessions"
      default: throw APIClientError.incompatibleData
      }
      let body = Body(
        account: account, agentId: action.agentID, authorizeAgent: true, authMethod: method.id,
        values: method.grantKind == "manual" ? values : nil,
        options: method.grantKind == "device-auth" ? options : nil)
      return try await client.request(
        "/api/connectors/\(slug)/\(route)", method: "POST", body: JSONEncoder().encode(body))
    }
    guard let custom = status.custom else { throw APIClientError.invalidResponse }
    if ["oauth", "automatic"].contains(custom.authMode) {
      struct Body: Encodable {
        let account: Account
        let agentId: String
      }
      return try await client.request(
        "/api/custom-connectors/\(custom.id)/oauth2/start", method: "POST",
        body: JSONEncoder().encode(Body(account: account, agentId: action.agentID)))
    }
    return try await configureCustom(custom, connectionID: status.account?.id, values: values)
  }
  public func configureCustom(
    _ custom: ChatCustomConnector, connectionID: String?, values: [String: String]
  ) async throws -> ChatConnectorReceipt {
    struct Account: Encodable {
      let intent: String
      let connectionId: String?
    }
    struct Value: Encodable {
      let key: String
      let kind: String
      let value: String
    }
    struct Body: Encodable {
      let account: Account
      let values: [Value]
    }
    let body = Body(
      account: Account(
        intent: connectionID == nil ? "add" : "reconnect", connectionId: connectionID),
      values: custom.fields.compactMap { field in
        guard let value = values[field.key], !value.isEmpty else { return nil }
        return Value(key: field.key, kind: field.kind, value: value)
      })
    return try await client.request(
      "/api/custom-connectors/\(custom.id)/values", method: "PUT", body: JSONEncoder().encode(body))
  }

  public func oauthCompletion(attemptID: String, target: ChatConnectorTarget) async throws
    -> String?
  {
    struct Response: Decodable, Sendable { let connectionId: String }
    do {
      let response: Response = try await client.request(
        "/api/connector-accounts/oauth-completions/\(attemptID)", query: target.query)
      guard UUID(uuidString: response.connectionId) != nil else {
        throw APIClientError.invalidResponse
      }
      return response.connectionId.lowercased()
    } catch let error as APIClientError where error.statusCode == 404 { return nil }
  }
  public func completeSession(slug: String, receipt: ChatConnectorReceipt, code: String?)
    async throws -> ChatConnectorReceipt
  {
    guard let id = receipt.sessionId, UUID(uuidString: id) != nil, let token = receipt.sessionToken
    else { throw APIClientError.invalidResponse }
    var body = ["sessionToken": token]
    body["code"] = code
    let route =
      code == nil ? "oauth/device/sessions/\(id)/poll" : "external-code/sessions/\(id)/complete"
    return try await client.request(
      "/api/connectors/\(slug)/\(route)", method: "POST", body: JSONEncoder().encode(body))
  }
}
