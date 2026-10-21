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
    id: String = accountID, custom: Bool = false, connected: Bool = true, setup: Bool = true
  ) -> String {
    let target =
      custom
      ? "{\"kind\":\"custom\",\"customConnectorId\":\"\(customID)\"}"
      : "{\"kind\":\"builtin\",\"connectorSlug\":\"slack\"}"
    return """
      {"id":"\(id)","target":\(target),"authMethod":"oauth","displayName":"Work account","externalEmail":"work@example.invalid","externalUsername":null,"externalId":null,"connectionStatus":"\(connected ? "connected" : "reconnect-required")","reconnectReason":null\(setup ? ",\"setupStatus\":\"complete\"" : "")}
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
    if path == "/api/connector-accounts" {
      let builtinDefault = connected ? account() : "null"
      let customDefault = connected ? account(custom: true) : "null"
      return ChatHTTPResponse(
        body: """
          {"summaries":[{"target":{"kind":"builtin","connectorSlug":"slack"},"defaultConnection":\(builtinDefault)},{"target":{"kind":"custom","customConnectorId":"\(customID)"},"defaultConnection":\(customDefault)}]}
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
