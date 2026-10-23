import Foundation

public enum ConnectorHTTPFixtures {
  public static let agentID = "98000000-0000-4000-8000-000000000001"
  public static let threadID = "98000000-0000-4000-8000-000000000002"
  public static let accountID = "98000000-0000-4000-8000-000000000003"
  public static let siblingID = "98000000-0000-4000-8000-000000000004"
  public static let attemptID = "98000000-0000-4000-8000-000000000005"
  public static let customID = "98000000-0000-4000-8000-000000000006"
  public static let metadata = """
    {"id":"\(threadID)","agentId":"\(agentID)","cloudBrowserEnabled":false,"computerUseHostId":null}
    """
  public static func account(
    id: String = accountID, custom: Bool = false, connected: Bool = true,
    reconnectReason: String? = nil, isDefault: Bool = true
  ) -> String {
    let target =
      custom
      ? "{\"kind\":\"custom\",\"customConnectorId\":\"\(customID)\"}"
      : "{\"kind\":\"builtin\",\"connectorSlug\":\"slack\"}"
    let reason = reconnectReason.map { "\"\($0)\"" } ?? "null"
    return """
      {"id":"\(id)","target":\(target),"authMethod":"oauth","displayName":"Work account","isDefault":\(isDefault),"externalEmail":"work@example.invalid","externalUsername":null,"externalId":null,"oauthScopes":null,"connectionStatus":"\(connected ? "connected" : "reconnect-required")","reconnectReason":\(reason),"tokenExpiresAt":null,"missingRequiredFields":[],"configuredFieldKeys":[],"createdAt":"2026-10-21T00:00:00Z","updatedAt":"2026-10-21T00:00:00Z"}
      """
  }
  public static func catalog(grantKind: String = "none") -> String {
    """
    {"connector":{"slug":"slack","label":"Slack","description":"Read messages","connectNotice":null,"authMethods":[{"id":"oauth","label":"Sign in","description":null,"grantKind":"\(grantKind)","manualFields":[],"startOptions":[]}]}}
    """
  }
  public static func custom(mode: String = "none") -> String {
    """
    {"id":"\(customID)","slug":"_internal","displayName":"Internal service","authMode":"\(mode)","permissionBundleRef":null,"fields":[]}
    """
  }
  public static func response(
    _ request: URLRequest, connected: Bool = true, authorized: Bool = true,
    grantKind: String = "none", customMode: String = "none"
  ) -> ChatHTTPResponse? {
    let path = request.url?.path ?? ""
    if path.hasSuffix("/metadata") { return ChatHTTPResponse(body: metadata) }
    if path == "/api/connector-catalog/slack" {
      return ChatHTTPResponse(body: catalog(grantKind: grantKind))
    }
    if path == "/api/custom-connectors" {
      return ChatHTTPResponse(body: "{\"connectors\":[\(custom(mode: customMode))]}")
    }
    if path == "/api/custom-connectors/\(customID)" {
      return ChatHTTPResponse(body: custom(mode: customMode))
    }
    if path == "/api/connector-accounts/connections" {
      let query =
        request.url.flatMap {
          URLComponents(url: $0, resolvingAgainstBaseURL: false)
        }?.queryItems ?? []
      let kind = query.first { $0.name == "kind" }?.value
      guard kind == "builtin" || kind == "custom" else { return nil }
      let custom = kind == "custom"
      let key = custom ? "customConnectorId" : "connectorSlug"
      guard query.first(where: { $0.name == key })?.value == (custom ? customID : "slack")
      else { return nil }
      let defaultAccount = connected ? account(custom: custom) : "null"
      return ChatHTTPResponse(
        body: """
          {"connections":\(connected ? "[\(defaultAccount)]" : "[]"),"nextCursor":null,"defaultConnection":\(defaultAccount)}
          """)
    }
    if path == "/api/connector-accounts/\(accountID)" {
      let custom =
        request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }?.queryItems?
        .contains { $0.name == "kind" && $0.value == "custom" } == true
      return ChatHTTPResponse(body: account(custom: custom, connected: connected))
    }
    if path.hasSuffix("/user-connectors") {
      return ChatHTTPResponse(
        body: "{\"enabledConnectorSlugs\":\(authorized ? "[\"slack\"]" : "[]")}")
    }
    if path.hasSuffix("/custom-connectors") {
      return ChatHTTPResponse(
        body:
          "{\"grants\":\(authorized ? "[{\"customConnectorId\":\"\(customID)\",\"permissionNames\":[]}]" : "[]")}"
      )
    }
    if path.hasSuffix("/connector-selections") {
      return ChatHTTPResponse(body: "{\"selections\":[]}")
    }
    if path == "/api/chat/events" {
      return ChatHTTPResponse(status: 201, body: "{\"threadId\":\"\(threadID)\"}")
    }
    return nil
  }
}
