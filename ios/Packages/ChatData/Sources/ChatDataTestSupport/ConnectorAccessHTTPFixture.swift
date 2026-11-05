import Foundation
import Synchronization

/// Stateful external contracts shared by native account, command and permission tests.
public final class ConnectorAccessHTTPFixture: Sendable {
  private typealias F = ConnectorHTTPFixtures
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
    public var accountIDs = [F.accountID, F.siblingID]
    public var enabled = [F.accountID: true, F.siblingID: false]
    public var defaultID: String? = F.accountID
    public var threads: [String: ThreadSettings] = [:]
    public var grants: [Grant] = []
    public var rejectCurrentOnce = false
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
  private static func target(_ state: State) -> Target {
    state.custom
      ? Target(kind: "custom", connectorSlug: nil, customConnectorId: F.customID)
      : Target(kind: "builtin", connectorSlug: "slack", customConnectorId: nil)
  }
  private static func json<T: Encodable>(_ value: T) throws -> String {
    String(decoding: try JSONEncoder().encode(value), as: UTF8.self)
  }
  private static func account(_ id: String, state: State) -> String {
    F.account(
      id: id, custom: state.custom, isDefault: state.defaultID == id,
      label: id == F.accountID ? "Work account" : "Personal account")
  }
  private static func defaults(_ state: State) -> String {
    "[" + state.accountIDs.map { defaultAccount($0, state: state) }.joined(separator: ",") + "]"
  }
  private static func defaultAccount(_ id: String, state: State) -> String {
    """
    {"connectionId":"\(id)","displayName":"\(id == F.accountID ? "Work account" : "Personal account")","defaultEnabled":\(state.enabled[id] == true),"isDefault":\(state.defaultID == id)}
    """
  }
  private static func repairDefault(_ state: inout State) {
    if state.defaultID.flatMap({ state.enabled[$0] }) != true {
      state.defaultID = state.accountIDs.first { state.enabled[$0] == true }
    }
  }
  private static func access(_ id: String, state: inout State) throws -> String {
    var settings = state.threads[id] ?? ThreadSettings()
    let enabled = state.accountIDs.filter {
      settings.overrides[$0] ?? (state.enabled[$0] == true)
    }
    if !enabled.contains(settings.currentID ?? "") {
      settings.currentID =
        state.defaultID.flatMap { enabled.contains($0) ? $0 : nil }
        ?? enabled.first
    }
    state.threads[id] = settings
    let rows = state.accountIDs.map { account in
      let inherited = settings.overrides[account].map { $0 ? "true" : "false" } ?? "null"
      return """
        {"connectionId":"\(account)","displayName":"Account","defaultEnabled":\(state.enabled[account] == true),"isDefault":\(state.defaultID == account),"overrideEnabled":\(inherited),"enabled":\(enabled.contains(account))}
        """
    }.joined(separator: ",")
    let current = settings.currentID.map { "\"\($0)\"" } ?? "null"
    return
      "{\"target\":\(try json(target(state))),\"accounts\":[\(rows)],\"currentConnectionId\":\(current),\"available\":\(!enabled.isEmpty)}"
  }

  private static func respond(_ request: URLRequest, state: inout State) throws -> ChatHTTPResponse
  {
    let path = request.url!.path
    let method = request.httpMethod ?? "GET"
    let parts = path.split(separator: "/").map(String.init)
    let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
    let queriedTarget = Target(
      kind: query.first { $0.name == "kind" }?.value ?? "",
      connectorSlug: query.first { $0.name == "connectorSlug" }?.value,
      customConnectorId: query.first { $0.name == "customConnectorId" }?.value)
    func error(_ status: Int, _ message: String) -> ChatHTTPResponse {
      ChatHTTPResponse(status: status, body: "{\"error\":{\"message\":\"\(message)\"}}")
    }
    if path == "/api/feature-switches" {
      return ChatHTTPResponse(
        body: "{\"effectiveSwitches\":{\"connectorChatAccountAccess\":true}}")
    }
    if path == "/api/agents" {
      return ChatHTTPResponse(body: "[{\"agentId\":\"\(F.agentID)\",\"isDefaultAgent\":true}]")
    }
    if parts.count == 3, parts[1] == "agents" {
      return ChatHTTPResponse(body: "{\"agentId\":\"\(parts[2])\",\"displayName\":\"Assistant\"}")
    }
    if path == "/api/connectors/connected" {
      let builtin =
        "[{\"slug\":\"slack\",\"label\":\"Slack\",\"hasPermissions\":\(state.hasPermissions)}]"
      let custom =
        "[{\"id\":\"\(F.customID)\",\"displayName\":\"Internal\",\"permissionBundleRef\":null,\"integrationManaged\":false}]"
      return ChatHTTPResponse(
        body:
          "{\"builtinConnectors\":\(state.custom ? "[]" : builtin),\"customConnectors\":\(state.custom ? custom : "[]")}"
      )
    }
    if path == "/api/remotes/overview" {
      return ChatHTTPResponse(
        body:
          "{\"computerUseHosts\":[],\"cloudBrowserAvailable\":true,\"cloudBrowserEnabledByDefault\":false,\"sshHosts\":[],\"vncHosts\":[]}"
      )
    }
    if path == "/api/connector-catalog/slack" { return ChatHTTPResponse(body: F.catalog()) }
    if path == "/api/custom-connectors/\(F.customID)" { return ChatHTTPResponse(body: F.custom()) }
    if path == "/api/connector-catalog/slack/permissions" {
      return ChatHTTPResponse(
        body:
          "{\"permissions\":{\"connectorSlug\":\"slack\",\"label\":\"Slack\",\"permissions\":[{\"name\":\"read\",\"description\":\"Read messages\"},{\"name\":\"write\",\"description\":\"Send messages\"}],\"defaultPolicy\":{\"permissionDefault\":\"ask\",\"permissionOverrides\":null,\"unknownPolicy\":\"ask\"},\"categories\":null}}"
      )
    }
    if path == "/api/connector-accounts/connections" {
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
    if parts.count == 3, parts[1] == "connector-accounts", state.accountIDs.contains(parts[2]) {
      guard queriedTarget == target(state) else { return error(403, "Wrong connector") }
      return ChatHTTPResponse(body: account(parts[2], state: state))
    }
    if path == "/api/connector-account-access/defaults" {
      guard queriedTarget == target(state) else { return error(403, "Wrong connector") }
      return ChatHTTPResponse(body: defaults(state))
    }
    if parts.count == 4, parts[1] == "connector-account-access", parts[3] == "default-enabled" {
      let body = try JSONDecoder().decode(Choice.self, from: chatRequestBody(request))
      guard body.target == target(state), state.accountIDs.contains(parts[2]),
        let enabled = body.enabled
      else { return error(403, "Account unavailable") }
      state.enabled[parts[2]] = enabled
      repairDefault(&state)
      return ChatHTTPResponse(body: defaultAccount(parts[2], state: state))
    }
    if parts.count == 4, parts[1] == "connector-accounts", parts[3] == "default" {
      let body = try JSONDecoder().decode(Choice.self, from: chatRequestBody(request))
      guard body.target == target(state), state.enabled[parts[2]] == true else {
        return error(403, "Default account must be enabled")
      }
      state.defaultID = parts[2]
      return ChatHTTPResponse(body: account(parts[2], state: state))
    }
    if path == "/api/connectors/slack/no-auth"
      || path == "/api/custom-connectors/\(F.customID)/values"
    {
      state.accountIDs.append(F.accountID)
      state.enabled[F.accountID] = true
      repairDefault(&state)
      return ChatHTTPResponse(body: "{\"connectionId\":\"\(F.accountID)\"}")
    }
    if path == "/api/connector-permissions" {
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
    if path == "/api/chat-threads", method == "POST" {
      struct Body: Decodable { let clientThreadId: String }
      let body = try JSONDecoder().decode(Body.self, from: chatRequestBody(request))
      let id = body.clientThreadId.lowercased()
      state.threads[id] = ThreadSettings()
      return ChatHTTPResponse(
        status: 201,
        body: "{\"id\":\"\(id)\",\"createdAt\":\"2026-11-03T00:00:00Z\",\"selectedModel\":null}")
    }
    if parts.count >= 4, parts[1] == "chat-threads" {
      let id = parts[2]
      if parts[3] == "metadata" {
        return ChatHTTPResponse(body: F.metadata.replacingOccurrences(of: F.threadID, with: id))
      }
      if parts[3] == "remote-access" { return ChatHTTPResponse(body: "{\"ssh\":[],\"vnc\":[]}") }
      if parts[3] == "connector-access" {
        if method == "GET", queriedTarget != target(state) { return error(403, "Wrong connector") }
        if method == "PUT", parts.count == 5 {
          let body = try JSONDecoder().decode(Choice.self, from: chatRequestBody(request))
          guard body.target == target(state), state.accountIDs.contains(parts[4]) else {
            return error(403, "Wrong account")
          }
          var settings = state.threads[id] ?? ThreadSettings()
          settings.overrides[parts[4]] = body.enabled
          state.threads[id] = settings
        }
        return ChatHTTPResponse(body: try access(id, state: &state))
      }
      if parts[3] == "connector-current" || parts[3] == "connector-account-approval" {
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
        return ChatHTTPResponse(body: try access(id, state: &state))
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
}
