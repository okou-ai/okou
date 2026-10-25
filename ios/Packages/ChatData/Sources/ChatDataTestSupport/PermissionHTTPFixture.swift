import Foundation
import Synchronization

/// External API fixture shared by data-boundary and native transcript tests.
public final class PermissionHTTPFixture: Sendable {
  public static let agentID = "61000000-0000-4000-8000-000000000001"
  public static let threadID = "61000000-0000-4000-8000-000000000002"
  public static let messageID = "61000000-0000-4000-8000-000000000003"
  public struct State: Sendable {
    public var grants = "[]"
    public var missingMetadata = false
    public var metadataStatus = 200
    public var permission = "mail.send"
    public var defaultPolicy = "ask"
    public var threadAgentID = PermissionHTTPFixture.agentID
    public var failApplyOnce = false
    public var loseApplyResponseOnce = false
    public var loseResumeResponseOnce = false
    public var requests: [URLRequest] = []
    public var events: [String] = []
    public init() {}
  }
  public final class ServerState: Sendable {
    private let storage: Mutex<State>
    init(_ initial: State) { storage = Mutex(initial) }
    public func withLock<T>(_ operation: (inout State) throws -> T) rethrows -> T {
      try storage.withLock { try operation(&$0) }
    }
  }
  public let state: ServerState
  public let http: ChatHTTPFixture

  public static func actionURL(
    action: String = "allow", permission: String = "mail.send", callback: Bool = true,
    duration: String = "1h"
  ) -> String {
    "/agents/\(agentID)/permissions?connectorSlug=gmail&permission=\(permission)&action=\(action)&expiresIn=\(duration)"
      + (callback ? "&threadId=\(threadID)&callbackPrompt=Continue%20after%20permission" : "")
  }

  public init(
    message: String? = nil, initial: State = State(),
    onUnhandledRequest: @escaping @Sendable (String) -> Void,
    beforeRequest: @escaping @Sendable (URLRequest) async -> Void = { _ in }
  ) {
    let state = ServerState(initial)
    self.state = state
    let message = message ?? Self.actionURL()
    http = ChatHTTPFixture(onUnhandledRequest: onUnhandledRequest) { request in
      await beforeRequest(request)
      try Task.checkCancellation()
      var request = request
      request.httpBody = chatRequestBody(request)
      return try state.withLock { value in
        value.requests.append(request)
        let path = request.url!.path
        let threadPath = "/api/chat-threads/\(Self.threadID)"
        if path == threadPath + "/activity-summary" {
          let body = try JSONDecoder().decode([String: String].self, from: chatRequestBody(request))
          let data = try JSONSerialization.data(withJSONObject: [
            "runId": body["runId"] ?? "", "status": "ineligible", "messages": [],
          ])
          return ChatHTTPResponse(body: String(decoding: data, as: UTF8.self))
        }
        if path == threadPath + "/metadata" {
          return ChatHTTPResponse(
            body: """
              {"id":"\(Self.threadID)","agentId":"\(value.threadAgentID)","computerUseHostId":null,"cloudBrowserEnabled":false}
              """)
        }
        if path == "/api/agents/\(Self.agentID)" {
          return ChatHTTPResponse(
            body: "{\"agentId\":\"\(Self.agentID)\",\"displayName\":\"Mail assistant\"}")
        }
        if path == "/api/connector-catalog/gmail/permissions" {
          if value.metadataStatus != 200 {
            return Self.error(value.metadataStatus, "Permission metadata failed")
          }
          if value.missingMetadata { return Self.error(404, "Metadata unavailable") }
          return ChatHTTPResponse(
            body: """
              {"permissions":{"connectorSlug":"gmail","label":"Gmail","permissions":[{"name":"\(value.permission)","description":"Send email from your account"}],"defaultPolicy":{"permissionDefault":"\(value.defaultPolicy)","unknownPolicy":"ask"}}}
              """)
        }
        if path == "/api/user-permission-grants" { return ChatHTTPResponse(body: value.grants) }
        if path == "/api/user-permission-grants/apply" {
          if value.failApplyOnce {
            value.failApplyOnce = false
            return Self.error(503, "Please retry permission")
          }
          let body =
            try JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any]
          let grant = (body?["grants"] as? [[String: Any]])?.first ?? [:]
          let action = grant["action"] as? String ?? "allow"
          value.grants = Self.grant(
            action: action, permission: grant["permission"] as? String ?? "mail.send",
            expiration: action == "deny" || grant["expiresIn"] as? String == "always"
              ? nil : "2099-01-01T00:00:00Z")
          if value.loseApplyResponseOnce {
            value.loseApplyResponseOnce = false
            return Self.error(503, "Permission response lost")
          }
          return ChatHTTPResponse(body: value.grants)
        }
        if path == threadPath + "/connector-selections" {
          return ChatHTTPResponse(body: "{\"selections\":[]}")
        }
        if path == threadPath + "/event-snapshot" {
          return ChatHTTPResponse(
            status: 404,
            body:
              "{\"error\":{\"code\":\"CHAT_EVENT_SNAPSHOT_NOT_FOUND\",\"message\":\"No snapshot\"}}"
          )
        }
        if path == threadPath + "/event-rows" {
          let initial = Self.row(
            id: Self.messageID, sequence: 1, type: "output.message", payload: ["content": message])
          let all = [initial] + value.events
          let since =
            URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?
            .first { $0.name == "sinceSeqId" }?.value.flatMap(Int.init) ?? 0
          let latest =
            value.events.last.flatMap { row -> String? in
              let data = Data(row.utf8)
              return (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["id"]
                as? String
            } ?? Self.messageID
          return ChatHTTPResponse(
            body:
              "{\"rows\":[\(all.dropFirst(since).joined(separator: ","))],\"cursor\":{\"lastEventId\":\"\(latest)\",\"lastSeqId\":\(all.count)},\"hasMore\":false}"
          )
        }
        if path == threadPath {
          return ChatHTTPResponse(body: "{\"cancellationRecoveryPending\":false}")
        }
        if path == "/api/chat/events" {
          let body =
            try JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any]
          let eventID = (body?["clientEventId"] as? String ?? UUID().uuidString).lowercased()
          if !value.events.contains(where: { $0.contains(eventID) }) {
            value.events.append(
              Self.row(
                id: eventID, sequence: value.events.count + 2,
                type: "input.prompt", payload: ["userMessage": body?["userMessage"] ?? [:]]))
          }
          if value.loseResumeResponseOnce {
            value.loseResumeResponseOnce = false
            return Self.error(503, "Continuation response lost")
          }
          return ChatHTTPResponse(body: "{\"threadId\":\"\(Self.threadID)\"}")
        }
        throw URLError(.unsupportedURL)
      }
    }
  }

  public static func grant(
    action: String = "allow", permission: String = "mail.send", expiration: String? = nil
  ) -> String {
    "[{\"agentId\":\"\(agentID)\",\"connectorSlug\":\"gmail\",\"permission\":\"\(permission)\",\"action\":\"\(action)\",\"expiresAt\":\(expiration.map { "\"\($0)\"" } ?? "null")}]"
  }

  private static func error(_ status: Int, _ message: String) -> ChatHTTPResponse {
    ChatHTTPResponse(status: status, body: "{\"error\":{\"message\":\"\(message)\"}}")
  }

  private static func row(id: String, sequence: Int, type: String, payload: [String: Any]) -> String
  {
    let encoded = try! JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
    return """
      {"id":"\(id)","chatThreadId":"\(threadID)","runId":"61000000-0000-4000-8000-000000000004","seqId":\(sequence),"createdAt":"2026-10-20T00:00:00Z","eventType":"\(type)","payload":\(String(decoding: encoded, as: UTF8.self))}
      """
  }
}
