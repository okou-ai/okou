import Foundation
import Synchronization

/// Isolated grants and chat event HTTP boundaries for batch permission consumers.
public final class PermissionBatchHTTPFixture: Sendable {
  public static let agentID = PermissionHTTPFixture.agentID
  public static let threadID = PermissionHTTPFixture.threadID
  public static let items = [
    ["connectorSlug": "gmail", "permission": "mail.read"],
    ["connectorSlug": "gmail", "permission": "mail.send"],
    ["connectorSlug": "google-drive", "permission": "files.read"],
    ["connectorSlug": "google-drive", "permission": "files.write"],
  ]

  public struct Grant: Codable, Sendable {
    public var agentId: String
    public var connectorSlug: String
    public var permission: String
    public var action: String
    public var expiresAt: String?
    public init(
      connectorSlug: String = "gmail", permission: String = "mail.read",
      action: String = "allow", expiresAt: String? = nil
    ) {
      agentId = PermissionBatchHTTPFixture.agentID
      self.connectorSlug = connectorSlug
      self.permission = permission
      self.action = action
      self.expiresAt = expiresAt
    }
  }

  public struct State: Sendable {
    public var enabled = true
    public var shared = false
    public var threadAgentID = PermissionBatchHTTPFixture.agentID
    public var grants: [Grant] = []
    public var metadataStatus: [String: Int] = [:]
    public var grantReadStatus = 200
    public var failConnector: String?
    public var loseBatchResponseOnce = false
    public var loseResumeResponseOnce = false
    public var failReadbackAfterWrite = false
    public var requests: [URLRequest] = []
    public var events: [String] = []
    public init() {}
  }

  public final class ServerState: Sendable {
    private let storage: Mutex<State>
    init(_ initial: State) { storage = Mutex(initial) }
    public func withLock<T>(_ operation: (inout State) throws -> T) rethrows -> T {
      try storage.withLock(operation)
    }
  }

  public let state: ServerState
  public let http: ChatHTTPFixture

  public static func actionURL(
    items: [[String: String]] = PermissionBatchHTTPFixture.items, callback: Bool = true,
    duration: String? = nil
  ) -> String {
    var components = URLComponents()
    components.path = "/agents/\(agentID)/permissions/batch"
    let json = try! JSONSerialization.data(withJSONObject: items, options: [.sortedKeys])
    components.queryItems = [
      URLQueryItem(name: "items", value: String(decoding: json, as: UTF8.self)),
      URLQueryItem(name: "action", value: "allow"),
    ]
    if let duration {
      components.queryItems!.append(URLQueryItem(name: "expiresIn", value: duration))
    }
    if callback {
      components.queryItems! += [
        URLQueryItem(name: "threadId", value: threadID),
        URLQueryItem(name: "callbackPrompt", value: "Continue after permissions"),
      ]
    }
    return components.string!
  }

  public init(
    initial: State = State(), onUnhandledRequest: @escaping @Sendable (String) -> Void,
    beforeRequest: @escaping @Sendable (URLRequest) async -> Void = { _ in }
  ) {
    state = ServerState(initial)
    let state = state
    http = ChatHTTPFixture(onUnhandledRequest: onUnhandledRequest) { request in
      await beforeRequest(request)
      try Task.checkCancellation()
      var request = request
      request.httpBody = chatRequestBody(request)
      return try state.withLock { value in
        value.requests.append(request)
        let path = request.url!.path
        let threadPath = "/api/chat-threads/\(Self.threadID)"
        if path == "/api/feature-switches" {
          return Self.response([
            "effectiveSwitches": [
              "batchConnectorPermissions": value.enabled,
              "connectorChatAccountAccess": value.shared,
            ]
          ])
        }
        if path == "/api/agents/\(Self.agentID)" {
          return Self.response(["agentId": Self.agentID, "displayName": "Mail assistant"])
        }
        if path == threadPath + "/metadata" {
          return Self.response([
            "id": Self.threadID, "agentId": value.threadAgentID,
            "computerUseHostId": NSNull(), "cloudBrowserEnabled": false,
          ])
        }
        for slug in ["gmail", "google-drive"] {
          if path == "/api/connector-catalog/\(slug)/permissions" {
            if let status = value.metadataStatus[slug], status != 200 {
              return Self.error(status)
            }
            return Self.response([
              "permissions": [
                "connectorSlug": slug, "label": slug == "gmail" ? "Gmail" : "Google Drive",
                "permissions": Self.items.filter { $0["connectorSlug"] == slug }.map {
                  ["name": $0["permission"]!, "description": "Use \($0["permission"]!)"]
                },
                "defaultPolicy": ["permissionDefault": "ask", "unknownPolicy": "ask"],
              ]
            ])
          }
        }
        if path == "/api/user-permission-grants" {
          if value.grantReadStatus != 200 { return Self.error(value.grantReadStatus) }
          return Self.encoded(value.grants)
        }
        if path == "/api/connector-permissions" {
          let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems
          if request.httpMethod == "GET" {
            if value.grantReadStatus != 200 { return Self.error(value.grantReadStatus) }
            let slug = query?.first { $0.name == "connectorSlug" }?.value ?? ""
            return Self.memberGrants(slug, grants: value.grants)
          }
          struct Body: Decodable {
            struct Target: Decodable { let connectorSlug: String }
            let target: Target
            let mode: String
            let grants: [Edit]
          }
          let body = try JSONDecoder().decode(Body.self, from: request.httpBody!)
          if value.failConnector == body.target.connectorSlug { return Self.error(503) }
          Self.apply(body.grants, slug: body.target.connectorSlug, state: &value)
          return Self.memberGrants(body.target.connectorSlug, grants: value.grants)
        }
        if path == "/api/user-permission-grants/apply-batch" {
          struct Body: Decodable {
            struct Group: Decodable {
              let connectorSlug: String
              let grants: [Edit]
            }
            let agentId: String
            let groups: [Group]
          }
          let body = try JSONDecoder().decode(Body.self, from: request.httpBody!)
          for group in body.groups {
            Self.apply(group.grants, slug: group.connectorSlug, state: &value)
          }
          if value.failReadbackAfterWrite { value.grantReadStatus = 503 }
          if value.loseBatchResponseOnce {
            value.loseBatchResponseOnce = false
            return Self.error(503)
          }
          return Self.encoded(value.grants)
        }
        if path == threadPath + "/connector-selections" {
          return Self.response(["selections": []])
        }
        if path == threadPath + "/event-snapshot" {
          return ChatHTTPResponse(
            status: 404,
            body: """
              {"error":{"code":"CHAT_EVENT_SNAPSHOT_NOT_FOUND","message":"No snapshot"}}
              """)
        }
        if path == threadPath + "/event-rows" {
          let initial = Self.row(
            id: PermissionHTTPFixture.messageID, sequence: 1, type: "output.message",
            payload: ["content": Self.actionURL()])
          let rows = [initial] + value.events
          let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems
          let since = query?.first { $0.name == "sinceSeqId" }?.value.flatMap(Int.init) ?? 0
          let latest =
            value.events.last.flatMap { row -> String? in
              let payload =
                try? JSONSerialization.jsonObject(with: Data(row.utf8)) as? [String: Any]
              return payload?["id"] as? String
            } ?? PermissionHTTPFixture.messageID
          return ChatHTTPResponse(
            body: """
              {"rows":[\(rows.dropFirst(since).joined(separator: ","))],"cursor":{"lastEventId":"\(latest)","lastSeqId":\(rows.count)},"hasMore":false}
              """)
        }
        if path == threadPath { return Self.response(["cancellationRecoveryPending": false]) }
        if path == "/api/chat/events" {
          let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
          let eventID = body["clientEventId"] as! String
          if !value.events.contains(where: { $0.contains(eventID) }) {
            value.events.append(
              Self.row(
                id: eventID, sequence: value.events.count + 2, type: "input.prompt",
                payload: ["userMessage": body["userMessage"]!]))
          }
          if value.loseResumeResponseOnce {
            value.loseResumeResponseOnce = false
            return Self.error(503)
          }
          return Self.response(["threadId": Self.threadID])
        }
        throw URLError(.unsupportedURL)
      }
    }
  }

  private struct Edit: Decodable {
    let permission: String
    let expiresIn: String
  }

  private static func apply(_ edits: [Edit], slug: String, state: inout State) {
    for edit in edits {
      state.grants.removeAll { $0.connectorSlug == slug && $0.permission == edit.permission }
      state.grants.append(
        Grant(
          connectorSlug: slug, permission: edit.permission,
          expiresAt: edit.expiresIn == "always" ? nil : "2099-01-01T00:00:00Z"))
    }
  }

  private static func memberGrants(_ slug: String, grants: [Grant]) -> ChatHTTPResponse {
    let json = try! JSONEncoder().encode(grants.filter { $0.connectorSlug == slug })
    return ChatHTTPResponse(
      body: """
        {"target":{"kind":"builtin","connectorSlug":"\(slug)"},"grants":\(String(decoding: json, as: UTF8.self))}
        """)
  }

  private static func encoded(_ grants: [Grant]) -> ChatHTTPResponse {
    ChatHTTPResponse(body: String(decoding: try! JSONEncoder().encode(grants), as: UTF8.self))
  }

  private static func error(_ status: Int) -> ChatHTTPResponse {
    ChatHTTPResponse(
      status: status, body: "{\"error\":{\"message\":\"Permission request failed\"}}")
  }

  private static func response(_ value: [String: Any]) -> ChatHTTPResponse {
    ChatHTTPResponse(
      body: String(decoding: try! JSONSerialization.data(withJSONObject: value), as: UTF8.self))
  }

  private static func row(id: String, sequence: Int, type: String, payload: [String: Any]) -> String
  {
    let encoded = try! JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
    return """
      {"id":"\(id)","chatThreadId":"\(threadID)","runId":"61000000-0000-4000-8000-000000000004","seqId":\(sequence),"createdAt":"2026-11-03T00:00:00Z","eventType":"\(type)","payload":\(String(decoding: encoded, as: UTF8.self))}
      """
  }
}
