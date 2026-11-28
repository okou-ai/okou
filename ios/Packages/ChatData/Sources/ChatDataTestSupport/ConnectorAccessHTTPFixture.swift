import Foundation
import Synchronization

/// Stateful external contracts shared by native account, command and permission tests.
public final class ConnectorAccessHTTPFixture: Sendable {
  private typealias FixtureData = ConnectorHTTPFixtures
  public struct ThreadSettings: Sendable {
    public var currentID: String?
    public var overrides: [String: Bool] = [:]
    public init() {}
  }
  public struct Grant: Codable, Sendable {
    public let permission: String
    public let action: String
    public let expiresAt: String?
    public init(permission: String, action: String, expiresAt: String? = nil) {
      self.permission = permission
      self.action = action
      self.expiresAt = expiresAt
    }
    enum CodingKeys: String, CodingKey { case permission, action, expiresAt }
    public func encode(to encoder: any Encoder) throws {
      var values = encoder.container(keyedBy: CodingKeys.self)
      try values.encode(permission, forKey: .permission)
      try values.encode(action, forKey: .action)
      try values.encode(expiresAt, forKey: .expiresAt)
    }
  }
  public struct State: Sendable {
    public var custom = false
    public var hasPermissions = true
    public var accountIDs = [FixtureData.accountID, FixtureData.siblingID]
    public var enabled = [FixtureData.accountID: true, FixtureData.siblingID: false]
    public var defaultID: String? = FixtureData.accountID
    public var threads: [String: ThreadSettings] = [:]
    public var grants: [Grant] = []
    public var rejectCurrentOnce = false
    public var rejectOverrideOnce = false
    public var memberAccess = false
    var policies: [String: Policy] = [:]
    public var requests: [URLRequest] = []
    public init() {}
  }
  public final class ServerState: Sendable {
    private let value: Mutex<State>
    init(_ initial: State) { value = Mutex(initial) }
    public func withLock<T>(_ operation: (inout State) throws -> T) rethrows -> T {
      try value.withLock { try operation(&$0) }
    }
  }
  public let state: ServerState
  public let http: ChatHTTPFixture

  public init(initial: State = State(), onUnhandledRequest: @escaping @Sendable (String) -> Void) {
    let state = ServerState(initial)
    self.state = state
    http = ChatHTTPFixture(onUnhandledRequest: onUnhandledRequest) { request in
      var request = request
      request.httpBody = chatRequestBody(request)
      return try state.withLock { value in
        value.requests.append(request)
        return try Self.respond(request, state: &value)
      }
    }
  }

  private struct Target: Codable, Equatable {
    let kind: String
    let connectorSlug: String?
    let customConnectorId: String?
  }
  private struct Choice: Decodable {
    let target: Target
    let connectionId: String?
    let enabled: Bool?
  }
  struct Policy: Encodable, Sendable {
    let connectionId: String
    let allowed: Bool
    let enabled: Bool
    let expiresAt: String?
  }

  private static func policy(_ id: String, state: State) -> Policy {
    let enabled = state.enabled[id] == true
    return state.policies[id]
      ?? Policy(connectionId: id, allowed: enabled, enabled: enabled, expiresAt: nil)
  }

  private static func updatePolicy(
    _ request: URLRequest, id: String, state: inout State
  ) throws -> ChatHTTPResponse {
    struct Body: Decodable {
      let target: Target
      let policy: String
    }
    let choice = try JSONDecoder().decode(Body.self, from: chatRequestBody(request))
    guard state.memberAccess, choice.target == target(state), state.accountIDs.contains(id) else {
      return error(403, "Policy unavailable")
    }
    let allowed = choice.policy != "deny"
    let expiry: String?
    switch choice.policy {
    case "allow-1h", "allow-24h", "allow-7d": expiry = "2099-01-01T00:00:00.000Z"
    case "allow-always", "deny": expiry = nil
    default: return error(400, "Unknown policy")
    }
    let result = Policy(connectionId: id, allowed: allowed, enabled: allowed, expiresAt: expiry)
    state.policies[id] = result
    return ChatHTTPResponse(body: try json(result))
  }

  private static func target(_ state: State) -> Target {
    state.custom
      ? Target(kind: "custom", connectorSlug: nil, customConnectorId: FixtureData.customID)
      : Target(kind: "builtin", connectorSlug: "slack", customConnectorId: nil)
  }
  private static func json<T: Encodable>(_ value: T) throws -> String {
    try JSONEncoder().encodeString(value)
  }
  private static func account(_ id: String, state: State) -> String {
    FixtureData.account(
      id: id, custom: state.custom, isDefault: state.defaultID == id,
      label: id == FixtureData.accountID ? "Work account" : "Personal account")
  }
  private static func defaults(_ state: State) -> String {
    "[" + state.accountIDs.map { defaultAccount($0, state: state) }.joined(separator: ",") + "]"
  }
  private static func defaultAccount(_ id: String, state: State) -> String {
    """
    {"connectionId":"\(id)","displayName":"\(id == FixtureData.accountID ? "Work account" : "Personal account")","defaultEnabled":\(state.enabled[id] == true),"isDefault":\(state.defaultID == id)}
    """
  }
  private static func repairDefault(_ state: inout State) {
    if state.defaultID.flatMap({ state.enabled[$0] }) != true {
      state.defaultID = state.accountIDs.first { state.enabled[$0] == true }
    }
  }
  private static func access(_ threadID: String?, state: State, overview: Bool = false) throws
    -> String
  {
    let settings = threadID.flatMap { state.threads[$0] } ?? ThreadSettings()
    let enabled = state.accountIDs.filter { id in
      if state.memberAccess { return policy(id, state: state).enabled }
      return settings.overrides[id] ?? (state.enabled[id] == true)
    }
    let current =
      enabled.first { $0 == settings.currentID }
      ?? enabled.first { $0 == state.defaultID } ?? enabled.first
    let rows = state.accountIDs.map { id in
      let inherited = settings.overrides[id].map { $0 ? "true" : "false" } ?? "null"
      return """
        {"connectionId":"\(id)","displayName":"Account","defaultEnabled":\(state.enabled[id] == true),"isDefault":\(state.defaultID == id),"overrideEnabled":\(inherited),"enabled":\(enabled.contains(id))}
        """
    }.joined(separator: ",")
    let fields =
      overview
      ? #""label":"\#(state.custom ? "Internal" : "Slack")","icon":null,"hasPermissions":\#(!state.custom && state.hasPermissions)"#
      : #""available":\#(current != nil)"#
    return """
      {"target":\(try json(target(state))),"accounts":[\(rows)],"currentConnectionId":\(try json(current)),\(fields)}
      """
  }

  private static func error(_ status: Int, _ message: String) -> ChatHTTPResponse {
    ChatHTTPResponse(status: status, body: "{\"error\":{\"message\":\"\(message)\"}}")
  }

  private static func connectionsResponse(
    query: [URLQueryItem], queriedTarget: Target, state: State
  ) -> ChatHTTPResponse {
    guard queriedTarget == target(state) else { return error(403, "Wrong connector") }
    let search = query.first { $0.name == "search" }?.value ?? ""
    let accounts = state.accountIDs.map { account($0, state: state) }.filter {
      search.isEmpty || $0.localizedCaseInsensitiveContains(search)
    }
    let current = state.defaultID.map { account($0, state: state) } ?? "null"
    return ChatHTTPResponse(
      body:
        "{\"connections\":[\(accounts.joined(separator: ","))],\"defaultConnection\":\(current),\"nextCursor\":null}"
    )
  }

  private static func setEnabledResponse(_ request: URLRequest, parts: [String], state: inout State)
    throws -> ChatHTTPResponse
  {
    let body = try JSONDecoder().decode(Choice.self, from: chatRequestBody(request))
    guard body.target == target(state), state.accountIDs.contains(parts[2]),
      let enabled = body.enabled
    else { return error(403, "Account unavailable") }
    state.enabled[parts[2]] = enabled
    repairDefault(&state)
    return ChatHTTPResponse(body: defaultAccount(parts[2], state: state))
  }

  private static func setDefaultResponse(_ request: URLRequest, parts: [String], state: inout State)
    throws -> ChatHTTPResponse
  {
    let body = try JSONDecoder().decode(Choice.self, from: chatRequestBody(request))
    guard body.target == target(state), state.enabled[parts[2]] == true else {
      return error(403, "Default account must be enabled")
    }
    state.defaultID = parts[2]
    return ChatHTTPResponse(body: account(parts[2], state: state))
  }

  private static func permissionsResponse(
    _ request: URLRequest, method: String, queriedTarget: Target, state: inout State
  ) throws -> ChatHTTPResponse {
    if method == "GET", queriedTarget != target(state) { return error(403, "Wrong connector") }
    if method == "PUT" {
      struct Edit: Decodable {
        let permission: String
        let action: String
        let expiresIn: String?
      }
      struct Body: Decodable {
        let target: Target
        let mode: String
        let grants: [Edit]
      }
      let body = try JSONDecoder().decode(Body.self, from: chatRequestBody(request))
      guard body.target == target(state) else { return error(403, "Wrong connector") }
      if body.mode == "replace" { state.grants = [] }
      for edit in body.grants {
        state.grants.removeAll { $0.permission == edit.permission }
        state.grants.append(
          Grant(
            permission: edit.permission, action: edit.action,
            expiresAt: edit.action == "allow" && edit.expiresIn != "always"
              ? "2099-01-01T00:00:00.000Z" : nil))
      }
    }
    return ChatHTTPResponse(
      body: "{\"target\":\(try json(target(state))),\"grants\":\(try json(state.grants))}")
  }

  private static func currentAccountResponse(
    _ request: URLRequest, parts: [String], id: String, state: inout State
  ) throws -> ChatHTTPResponse {
    let body = try JSONDecoder().decode(Choice.self, from: chatRequestBody(request))
    guard body.target == target(state), let account = body.connectionId,
      state.accountIDs.contains(account)
    else { return error(403, "Wrong account") }
    if state.rejectCurrentOnce {
      state.rejectCurrentOnce = false
      return error(403, "Account selection rejected")
    }
    var settings = state.threads[id] ?? ThreadSettings()
    if parts[3] == "connector-account-approval" { settings.overrides[account] = true }
    guard settings.overrides[account] ?? (state.enabled[account] == true) else {
      return error(403, "Account is disabled")
    }
    settings.currentID = account
    state.threads[id] = settings
    if parts[3] == "connector-account-approval" {
      return ChatHTTPResponse(
        body: "{\"target\":\(try json(body.target)),\"connectionId\":\"\(account)\"}")
    }
    return ChatHTTPResponse(body: try access(id, state: state))
  }

  private static func connectorAccessResponse(
    _ request: URLRequest, method: String, queriedTarget: Target, parts: [String],
    state: inout State
  ) throws -> ChatHTTPResponse {
    let id = parts[2]
    if method == "GET", queriedTarget != target(state) { return error(403, "Wrong connector") }
    if method == "PUT", parts.count == 5 {
      let body = try JSONDecoder().decode(Choice.self, from: chatRequestBody(request))
      guard body.target == target(state), state.accountIDs.contains(parts[4]) else {
        return error(403, "Wrong account")
      }
      if state.rejectOverrideOnce {
        state.rejectOverrideOnce = false
        return error(403, "Account access change rejected")
      }
      var settings = state.threads[id] ?? ThreadSettings()
      settings.overrides[parts[4]] = body.enabled
      state.threads[id] = settings
    }
    return ChatHTTPResponse(body: try access(id, state: state))
  }

  private static func createThreadResponse(_ request: URLRequest, state: inout State) throws
    -> ChatHTTPResponse
  {
    struct Body: Decodable { let clientThreadId: String }
    let body = try JSONDecoder().decode(Body.self, from: chatRequestBody(request))
    let id = body.clientThreadId.lowercased()
    state.threads[id] = ThreadSettings()
    return ChatHTTPResponse(
      status: 201,
      body: "{\"id\":\"\(id)\",\"createdAt\":\"2026-11-03T00:00:00Z\",\"selectedModel\":null}")
  }

  private static func threadResponse(
    _ request: URLRequest, parts: [String], method: String, queriedTarget: Target,
    state: inout State
  ) throws -> ChatHTTPResponse? {
    let id = parts[2]
    if parts[3] == "metadata" {
      return ChatHTTPResponse(
        body: FixtureData.metadata.replacingOccurrences(of: FixtureData.threadID, with: id))
    }
    if parts[3] == "remote-access" { return ChatHTTPResponse(body: "{\"ssh\":[],\"vnc\":[]}") }
    if parts[3] == "connector-access" {
      return try connectorAccessResponse(
        request, method: method, queriedTarget: queriedTarget, parts: parts, state: &state
      )
    }
    if parts[3] == "connector-current" || parts[3] == "connector-account-approval" {
      return try currentAccountResponse(request, parts: parts, id: id, state: &state)
    }
    return nil
  }

  private static func catalogResponse(path: String) -> ChatHTTPResponse? {
    if path == "/api/connector-catalog/slack" {
      return ChatHTTPResponse(body: FixtureData.catalog())
    }
    if path == "/api/custom-connectors/\(FixtureData.customID)" {
      return ChatHTTPResponse(body: FixtureData.custom())
    }
    if path == "/api/connector-catalog/slack/permissions" {
      return ChatHTTPResponse(
        body:
          "{\"permissions\":{\"connectorSlug\":\"slack\",\"label\":\"Slack\",\"permissions\":[{\"name\":\"read\",\"description\":\"Read messages\"},{\"name\":\"write\",\"description\":\"Send messages\"}],\"defaultPolicy\":{\"permissionDefault\":\"ask\",\"permissionOverrides\":null,\"unknownPolicy\":\"ask\"},\"categories\":null}}"
      )
    }
    return nil
  }

  private static func respond(
    _ request: URLRequest, state: inout State
  ) throws -> ChatHTTPResponse {
    let path = request.url!.path
    let method = request.httpMethod ?? "GET"
    let parts = path.split(separator: "/").map(String.init)
    let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
    let queriedTarget = Target(
      kind: query.first { $0.name == "kind" }?.value ?? "",
      connectorSlug: query.first { $0.name == "connectorSlug" }?.value,
      customConnectorId: query.first { $0.name == "customConnectorId" }?.value)
    if path == "/api/chat-connector-overview" {
      let threadID = query.first { $0.name == "threadId" }?.value
      return ChatHTTPResponse(body: "[\(try access(threadID, state: state, overview: true))]")
    }
    if path == "/api/remotes/overview" {
      return ChatHTTPResponse(
        body:
          "{\"computerUseHosts\":[],\"cloudBrowserAvailable\":true,\"cloudBrowserEnabledByDefault\":false,\"sshHosts\":[],\"vncHosts\":[]}"
      )
    }
    if let response = catalogResponse(path: path) { return response }
    if path == "/api/connector-accounts/connections" {
      return connectionsResponse(query: query, queriedTarget: queriedTarget, state: state)
    }
    if parts.count == 3, parts[1] == "connector-accounts", state.accountIDs.contains(parts[2]) {
      guard queriedTarget == target(state) else { return error(403, "Wrong connector") }
      return ChatHTTPResponse(body: account(parts[2], state: state))
    }
    if path == "/api/connector-account-access/defaults" {
      guard queriedTarget == target(state) else { return error(403, "Wrong connector") }
      return ChatHTTPResponse(body: defaults(state))
    }
    if let response = try policyResponse(
      request, parts: parts, queriedTarget: queriedTarget, state: &state)
    {
      return response
    }
    if parts.count == 4, parts[1] == "connector-account-access", parts[3] == "default-enabled" {
      return try setEnabledResponse(request, parts: parts, state: &state)
    }
    if parts.count == 4, parts[1] == "connector-accounts", parts[3] == "default" {
      return try setDefaultResponse(request, parts: parts, state: &state)
    }
    if path == "/api/connectors/slack/no-auth"
      || path == "/api/custom-connectors/\(FixtureData.customID)/values"
    {
      state.accountIDs.append(FixtureData.accountID)
      state.enabled[FixtureData.accountID] = true
      repairDefault(&state)
      return ChatHTTPResponse(body: "{\"connectionId\":\"\(FixtureData.accountID)\"}")
    }
    if path == "/api/connector-permissions" {
      return try permissionsResponse(
        request, method: method, queriedTarget: queriedTarget, state: &state)
    }
    if path == "/api/chat-threads", method == "POST" {
      return try createThreadResponse(request, state: &state)
    }
    if parts.count >= 4, parts[1] == "chat-threads" {
      if let response = try threadResponse(
        request, parts: parts, method: method, queriedTarget: queriedTarget, state: &state)
      {
        return response
      }
    }
    if path == "/api/chat/events" {
      struct Body: Decodable { let threadId: String }
      let body = try JSONDecoder().decode(Body.self, from: chatRequestBody(request))
      return ChatHTTPResponse(status: 201, body: "{\"threadId\":\"\(body.threadId)\"}")
    }
    if let response = ModelHTTPFixtures.response(path) { return response }
    throw URLError(.unsupportedURL)
  }

  private static func policyResponse(
    _ request: URLRequest, parts: [String], queriedTarget: Target, state: inout State
  ) throws -> ChatHTTPResponse? {
    switch request.url?.path {
    case "/api/chat-connector-overview/target":
      guard state.memberAccess, queriedTarget == target(state) else {
        return error(403, "Policy unavailable")
      }
      return ChatHTTPResponse(
        body: #"{"connector":\#(try access(nil, state: state, overview: true))}"#)
    case "/api/connector-account-access/policies":
      guard state.memberAccess, queriedTarget == target(state) else {
        return error(403, "Policy unavailable")
      }
      return ChatHTTPResponse(body: try json(state.accountIDs.map { policy($0, state: state) }))
    default:
      guard request.httpMethod == "PUT", parts.count == 4, parts[1] == "connector-account-access",
        parts[3] == "policy"
      else { return nil }
      return try updatePolicy(request, id: parts[2], state: &state)
    }
  }
}
