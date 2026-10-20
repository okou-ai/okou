import ChatData
import ChatDataTestSupport
import ChatDomain
import Foundation
import Synchronization

@testable import Okou

/// Mixed variable-height messages served through the real event-decoding and replay boundary.
final class ConversationHistoryFixture: Sendable {
  static let threadID = "60000000-0000-4000-8000-000000000001"
  static let agentID = "60000000-0000-4000-8000-000000000002"
  let http: ChatHTTPFixture
  let requests = HistoryRequests()
  private let rows: HistoryRows

  convenience init(count: Int = 100) {
    self.init(rows: (0..<count).map { Self.row($0 + 1) })
  }

  init(rows initial: [String], fileOrigin: URL? = nil) {
    let rows = HistoryRows(initial)
    self.rows = rows
    let requests = requests
    http = ChatHTTPFixture { request in
      requests.values.withLock {
        $0.append("\(request.httpMethod ?? "GET") \(request.url?.path ?? "")")
      }
      let path = "/api/chat-threads/\(Self.threadID)"
      switch request.url?.path {
      case "/api/web/file-url":
        guard let fileOrigin else { throw URLError(.unsupportedURL) }
        let id =
          URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first?.value
          ?? "file"
        return ChatHTTPResponse(
          body:
            "{\"url\":\"\(fileOrigin)/\(id)\",\"downloadUrl\":\"\(fileOrigin)/\(id)\",\"previewImageUrl\":null}"
        )
      case path + "/event-snapshot":
        return ChatHTTPResponse(
          status: 404,
          body:
            "{\"error\":{\"code\":\"CHAT_EVENT_SNAPSHOT_NOT_FOUND\",\"message\":\"No snapshot\"}}")
      case path + "/event-rows":
        let after =
          URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
          .queryItems?.first { $0.name == "sinceSeqId" }?.value.flatMap(Int.init) ?? 0
        return rows.values.withLock { values in
          let last = min(values.count, after + 50)
          let cursorID = last == 0 ? "null" : "\"\(Self.id(last))\""
          return ChatHTTPResponse(
            body: """
              {"rows":[\(values[after..<last].joined(separator: ","))],"cursor":{"lastEventId":\(cursorID),"lastSeqId":\(last)},"hasMore":\(last < values.count)}
              """)
        }
      case path: return ChatHTTPResponse(body: "{\"cancellationRecoveryPending\":false}")
      case path + "/mark-read":
        return ChatHTTPResponse(body: "{\"lastReadAt\":\"2026-10-20T00:00:00Z\"}")
      case path + "/connector-selections": return ChatHTTPResponse(body: "{\"selections\":[]}")
      case path + "/metadata":
        return ChatHTTPResponse(
          body:
            "{\"id\":\"\(Self.threadID)\",\"agentId\":\"\(Self.agentID)\",\"computerUseHostId\":null,\"cloudBrowserEnabled\":false}"
        )
      case "/api/chat/events":
        return ChatHTTPResponse(
          status: 503, body: "{\"error\":{\"message\":\"Delivery unavailable\"}}")
      default: throw URLError(.unsupportedURL)
      }
    }
  }

  func appendMessage() { rows.values.withLock { $0.append(Self.row($0.count + 1)) } }

  func append(_ row: String) { rows.values.withLock { $0.append(row) } }

  func revoke(_ sequence: Int) {
    rows.values.withLock { values in
      values.append(Self.row(values.count + 1, revokes: sequence))
    }
  }

  @MainActor
  func conversation(cache: ChatCache? = nil) -> ConversationStore {
    let sync = ChatSync(client: http.client, cache: cache)
    return ConversationStore(
      thread: ChatThread(
        id: Self.threadID, agentID: Self.agentID, title: "History", createdAt: .now,
        updatedAt: .now, sortAt: .now, pinnedAt: nil, pinOrder: nil),
      sync: sync, commands: ChatCommands(client: http.client, sync: sync),
      webURL: http.baseURL, messageMarkdown: MessageMarkdownCache(baseURL: http.baseURL),
      isVisible: { true }, didMarkRead: { _ in }, didSend: {}, didFail: { _ in }, didSettle: {})
  }

  static func id(_ sequence: Int) -> String {
    String(format: "60000000-0000-4000-8000-%012d", sequence + 10)
  }

  private static func row(_ sequence: Int, revokes: Int? = nil) -> String {
    let text =
      sequence.isMultiple(of: 5)
      ? "## Message \(sequence)\n\n```swift\nlet example = \(sequence)\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |"
      : "Message \(sequence)\n\n"
        + String(repeating: "Variable height content. ", count: sequence % 4 + 1)
    let payload: Data
    let type: String
    if revokes != nil {
      type = "control.revoke"
      payload = Data("null".utf8)
    } else if sequence.isMultiple(of: 2) {
      type = "output.message"
      payload = try! JSONEncoder().encode(["content": text])
    } else {
      type = "input.prompt"
      payload = try! JSONEncoder().encode(
        UserPayload(userMessage: Document(parts: [Part(text: text)])))
    }
    return """
      {"id":"\(id(sequence))","chatThreadId":"\(threadID)","runId":null,"revokesEventId":\(revokes.map { "\"\(id($0))\"" } ?? "null"),"contextType":null,"contextId":null,"runEventSequenceNumber":null,"runEventId":null,"seqId":\(sequence),"createdAt":"2026-10-08T00:00:00.000Z","eventType":"\(type)","payload":\(String(decoding: payload, as: UTF8.self))}
      """
  }

  private struct UserPayload: Encodable { let userMessage: Document }
  private struct Document: Encodable {
    let version = 1
    let parts: [Part]
  }
  private struct Part: Encodable {
    let type = "text"
    let text: String
  }
}

private final class HistoryRows: Sendable {
  let values: Mutex<[String]>
  init(_ rows: [String]) { values = Mutex(rows) }
}

final class HistoryRequests: Sendable {
  let values = Mutex<[String]>([])
}
