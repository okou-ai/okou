import Foundation

public enum ConnectorHTTPFixtures {
  public static let threadID = "98000000-0000-4000-8000-000000000002"
  public static let accountID = "98000000-0000-4000-8000-000000000003"
  public static let siblingID = "98000000-0000-4000-8000-000000000004"
  public static let attemptID = "98000000-0000-4000-8000-000000000005"
  public static let customID = "98000000-0000-4000-8000-000000000006"
  public static let metadata = """
    {"id":"\(threadID)","cloudBrowserEnabled":false,"computerUseHostId":null}
    """
  public static func account(
    id: String = accountID, custom: Bool = false, connected: Bool = true,
    reconnectReason: String? = nil, isDefault: Bool = true, label: String = "Work account",
    missingRequiredFieldsJSON: String = "[]"
  ) -> String {
    let target =
      custom
      ? "{\"kind\":\"custom\",\"customConnectorId\":\"\(customID)\"}"
      : "{\"kind\":\"builtin\",\"connectorSlug\":\"slack\"}"
    let reason = reconnectReason.map { "\"\($0)\"" } ?? "null"
    return """
      {"id":"\(id)","target":\(target),"authMethod":"oauth","displayName":"\(label)","isDefault":\(isDefault),"externalEmail":"work@example.invalid","externalUsername":null,"externalId":null,"oauthScopes":null,"connectionStatus":"\(connected ? "connected" : "reconnect-required")","reconnectReason":\(reason),"tokenExpiresAt":null,"missingRequiredFields":\(missingRequiredFieldsJSON),"configuredFieldKeys":[],"createdAt":"2026-10-21T00:00:00Z","updatedAt":"2026-10-21T00:00:00Z"}
      """
  }
  public static func catalog(
    grantKind: String = "none", slug: String = "slack", manualFieldsJSON: String = "[]",
    startOptionsJSON: String = "[]"
  ) -> String {
    """
    {"connector":{"slug":"\(slug)","label":"Slack","description":"Read messages","connectNotice":null,"authMethods":[{"id":"oauth","label":"Sign in","description":null,"grantKind":"\(grantKind)","manualFields":\(manualFieldsJSON),"startOptions":\(startOptionsJSON)}]}}
    """
  }
  public static func custom(mode: String = "none", fieldsJSON: String = "[]") -> String {
    """
    {"id":"\(customID)","slug":"_internal","displayName":"Internal service","authMode":"\(mode)","permissionBundleRef":null,"fields":\(fieldsJSON)}
    """
  }
  public static func response(
    _ request: URLRequest, connected: Bool = true,
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
    if path == "/api/chat/events" {
      return ChatHTTPResponse(status: 201, body: "{\"threadId\":\"\(threadID)\"}")
    }
    return nil
  }

  public static func composerOverview(label: String = "Slack") -> String {
    """
    [{"target":{"kind":"builtin","connectorSlug":"slack"},"label":"\(label)","hasPermissions":false,
      "accounts":[{"connectionId":"\(accountID)","defaultEnabled":true,"isDefault":true,"enabled":true}],
      "currentConnectionId":"\(accountID)"}]
    """
  }

  public static let managedOverview = """
    [{"target":{"kind":"builtin","connectorSlug":"slack"},"label":"Slack","hasPermissions":true,
      "icon":{"url":"https://example.invalid/slack.svg","invertInDarkMode":true},
      "accounts":[
        {"connectionId":"\(accountID)","displayName":"Work","defaultEnabled":true,"isDefault":true,"enabled":false},
        {"connectionId":"\(siblingID)","displayName":"Personal","defaultEnabled":false,"isDefault":false,"enabled":false}],
      "currentConnectionId":null},
     {"target":{"kind":"custom","customConnectorId":"\(customID)"},"label":"Custom","hasPermissions":false,
      "accounts":[],"currentConnectionId":null}]
    """

  public static func managedInspection(
    kind: String = "available", slug: String = "slack"
  ) -> String {
    let status = kind == "available" ? #","connectionStatus":"reconnect-required""# : ""
    return """
      {"results":[
        {"kind":"available","connectionId":"\(accountID)",
         "target":{"kind":"builtin","connectorSlug":"slack"},"connectionStatus":"connected"},
        {"kind":"\(kind)","connectionId":"\(siblingID)",
         "target":{"kind":"builtin","connectorSlug":"\(slug)"}\(status)}]}
      """
  }

  public static func access(slug: String = "slack", currentID: String? = accountID) -> String {
    let current = currentID.map { "\"\($0)\"" } ?? "null"
    return """
      {"target":{"kind":"builtin","connectorSlug":"\(slug)"},"accounts":[{"connectionId":"\(accountID)","displayName":"Work account","defaultEnabled":true,"isDefault":true,"overrideEnabled":null,"enabled":true}],"currentConnectionId":\(current),"available":\(currentID != nil)}
      """
  }
}
