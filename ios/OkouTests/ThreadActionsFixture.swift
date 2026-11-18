import ChatData
import ChatDataTestSupport
import ChatDomain
import Foundation
import Synchronization
import XCTest

@testable import Okou

final class ThreadActionGate: Sendable {
  private let stream: AsyncStream<Void>
  private let continuation: AsyncStream<Void>.Continuation
  init() {
    (stream, continuation) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
  }
  func open() {
    continuation.yield(())
    continuation.finish()
  }
  func wait() async { for await _ in stream { return } }
}

final class ThreadActionsFixture: Sendable {
  static let thread = "78000000-0000-4000-8000-000000000001"
  static let createdThread = "78000000-0000-4000-8000-000000000004"
  static let agent = "78000000-0000-4000-8000-000000000002"
  static let otherAgent = "78000000-0000-4000-8000-000000000003"
  static let project = "78000000-0000-4000-8000-000000000071"
  static let otherProject = "78000000-0000-4000-8000-000000000072"
  static let date = "2026-10-21T00:00:00Z"
  struct Write: Sendable {
    let action: String
    let eventID: String?
    let title: String?
  }
  struct State: Sendable {
    var muted = false
    var unread = true
    var title = "Planning a useful week"
    var failNext: [String: Int] = [:]
    var nextGate: ThreadActionGate?
    var nextWriteRequested: (@Sendable () -> Void)?
    var writes: [Write] = []
    var events: [String] = []
  }
  final class StateBox: Sendable { let value = Mutex(State()) }
  let state: StateBox
  let http: ChatHTTPFixture
  var writes: [Write] { state.value.withLock { $0.writes } }
  @MainActor
  func workspace() -> WorkspaceStore { WorkspaceStore(client: http.client, webURL: http.baseURL) }

  init(muted: Bool = false) {
    let state = StateBox()
    state.value.withLock { $0.muted = muted }
    self.state = state
    http = ChatHTTPFixture { request in
      let path = request.url?.path ?? ""
      if request.httpMethod == "PUT", path == "/api/chat-threads/\(Self.thread)/project" {
        struct Membership: Decodable {
          let eventId: String
          let projectId: String?
        }
        let body = try JSONDecoder().decode(Membership.self, from: chatRequestBody(request))
        let (gate, status, requested) = state.value.withLock { state in
          state.writes.append(Write(action: "project", eventID: body.eventId, title: nil))
          let gate = state.nextGate
          let requested = state.nextWriteRequested
          state.nextGate = nil
          state.nextWriteRequested = nil
          return (gate, state.failNext.removeValue(forKey: "project") ?? 200, requested)
        }
        requested?()
        await gate?.wait()
        try Task.checkCancellation()
        if status != 200 {
          return ChatHTTPResponse(
            status: status, body: #"{"error":{"message":"Project move unavailable"}}"#)
        }
        let project = body.projectId.map { "\"\($0)\"" } ?? "null"
        state.value.withLock {
          $0.events.append(
            Self.event(
              kind: "project_updated", id: body.eventId, seq: $0.events.count + 1,
              extra: ",\"projectId\":\(project)"))
        }
        return ChatHTTPResponse(
          body: "{\"threadId\":\"\(Self.thread)\",\"projectId\":\(project)}")
      }
      if request.httpMethod == "POST", path == "/api/chat-threads" {
        let (gate, requested) = state.value.withLock { state in
          state.writes.append(Write(action: "create", eventID: nil, title: nil))
          let gate = state.nextGate
          let requested = state.nextWriteRequested
          state.nextGate = nil
          state.nextWriteRequested = nil
          return (gate, requested)
        }
        requested?()
        await gate?.wait()
        try Task.checkCancellation()
        return ChatHTTPResponse(
          status: 201,
          body:
            "{\"id\":\"\(Self.createdThread)\",\"title\":null,\"createdAt\":\"\(Self.date)\",\"selectedModel\":null}"
        )
      }
      if request.httpMethod == "POST" {
        return try await Self.mutate(request, path: path, state: state)
      }
      return try Self.read(request, path: path, state: state, muted: muted)
    }
  }

  private static func mutate(
    _ request: URLRequest, path: String, state: StateBox
  ) async throws -> ChatHTTPResponse {
    XCTAssertEqual(
      request.value(forHTTPHeaderField: "Authorization"), "Bearer local-test-session")
    XCTAssertEqual(request.value(forHTTPHeaderField: "X-Client-Type"), "iOS")
    let action = String(path.split(separator: "/").last ?? "")
    let renameBody =
      action == "rename"
      ? try JSONDecoder().decode([String: String].self, from: chatRequestBody(request)) : [:]
    let queryEventID = URLComponents(
      url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?.queryItems?.first {
        $0.name == "eventId"
      }?.value
    let eventID = renameBody["eventId"] ?? queryEventID
    let title = renameBody["title"]
    let (gate, status, requested) = state.value.withLock { state in
      state.writes.append(Write(action: action, eventID: eventID, title: title))
      let gate = state.nextGate
      let requested = state.nextWriteRequested
      state.nextGate = nil
      state.nextWriteRequested = nil
      return (gate, state.failNext.removeValue(forKey: action) ?? 204, requested)
    }
    requested?()
    await gate?.wait()
    try Task.checkCancellation()
    if status != 204 {
      return ChatHTTPResponse(
        status: status, body: "{\"error\":{\"message\":\"\(action) unavailable\"}}")
    }
    if action == "mark-read" {
      state.value.withLock { $0.unread = false }
      return ChatHTTPResponse(body: "{\"lastReadAt\":\"2026-10-21T01:00:00Z\"}")
    }
    state.value.withLock { state in
      let kind: String
      var extra = ""
      switch action {
      case "mute", "unmute":
        kind = "sort_touched"
        state.muted = action == "mute"
        extra = ",\"muted\":\(state.muted)"
      case "archive": kind = "archived"
      case "unarchive": kind = "unarchived"
      case "rename":
        kind = "renamed"
        state.title = title ?? ""
        let encoded = try? JSONEncoder().encodeString(state.title)
        extra = ",\"title\":\(encoded ?? "null")"
      default:
        XCTFail("Unexpected mutation: \(path)")
        return
      }
      state.events.append(
        Self.event(
          kind: kind, id: eventID ?? UUID().uuidString, seq: state.events.count + 1,
          extra: extra))
    }
    return ChatHTTPResponse(status: 204, body: "")
  }

  private static func read(
    _ request: URLRequest, path: String, state: StateBox, muted: Bool
  ) throws -> ChatHTTPResponse {
    switch path {
    case "/api/user-model-preference":
      return ChatHTTPResponse(
        body:
          "{\"selectedModel\":null,\"serviceTier\":null,\"modelSettings\":{},\"selectedImageModel\":null,\"updatedAt\":null}"
      )
    case "/api/run-models": return runModelsResponse()
    case "/api/model-catalog": return modelCatalogResponse()
    case "/api/chat-threads/\(Self.thread)/metadata":
      return ChatHTTPResponse(
        body:
          "{\"id\":\"\(Self.thread)\",\"agentId\":\"\(Self.agent)\",\"selectedModel\":null,\"modelSettings\":{},\"serviceTier\":null,\"computerUseHostId\":null,\"cloudBrowserEnabled\":false}"
      )
    case "/api/chat-threads/\(Self.thread)/event-snapshot":
      return ChatHTTPResponse(
        status: 404,
        body:
          "{\"error\":{\"code\":\"CHAT_EVENT_SNAPSHOT_NOT_FOUND\",\"message\":\"No snapshot\"}}")
    case "/api/chat-threads/\(Self.thread)/event-rows":
      let since =
        Int(
          URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first {
            $0.name == "sinceSeqId"
          }?.value ?? "0") ?? 0
      let rows =
        since == 0
        ? [
          Self.message(
            1, type: "input.prompt",
            payload:
              "{\"userMessage\":{\"version\":1,\"parts\":[{\"type\":\"text\",\"text\":\"Help me make room for focused work this week.\"}]}}"
          ),
          Self.message(
            2, type: "output.message",
            payload:
              "{\"content\":\"Start with the two things that matter most.\\n\\n- Reserve a quiet morning for the main project.\\n- Keep a short list of follow-ups for tomorrow.\\n\\nYou can keep this conversation close by or mute it while you focus.\"}"
          )
        ].joined(separator: ",") : ""
      return ChatHTTPResponse(
        body:
          "{\"rows\":[\(rows)],\"cursor\":{\"lastEventId\":\"\(Self.messageID(2))\",\"lastSeqId\":2},\"hasMore\":false}"
      )
    case "/api/chat-threads/\(Self.thread)":
      return ChatHTTPResponse(body: "{\"lastReadAt\":null,\"cancellationRecoveryPending\":false}")
    case "/api/chat-threads/\(Self.thread)/connector-selections":
      return ChatHTTPResponse(body: "{\"selections\":[]}")
    case "/api/agents":
      return ChatHTTPResponse(
        body:
          "[{\"agentId\":\"\(Self.agent)\",\"isDefaultAgent\":true,\"displayName\":\"Okou\"},{\"agentId\":\"\(Self.otherAgent)\",\"isDefaultAgent\":false,\"displayName\":\"Research\"}]"
      )

    case "/api/feature-switches":
      return ChatHTTPResponse(body: "{\"effectiveSwitches\":{}}")
    case "/api/chat-threads/snapshot":
      return ChatHTTPResponse(
        body:
          "{\"chatThreads\":[{\"id\":\"\(Self.thread)\",\"agentId\":\"\(Self.agent)\",\"title\":\"Planning a useful week\",\"muted\":\(muted),\"createdAt\":\"\(Self.date)\",\"updatedAt\":\"\(Self.date)\",\"sortAt\":\"\(Self.date)\"}],\"latestEventId\":null,\"latestSeqId\":null}"
      )
    case "/api/chat-threads/events":
      if let status = state.value.withLock({ $0.failNext.removeValue(forKey: "events") }) {
        return ChatHTTPResponse(
          status: status, body: #"{"error":{"message":"List refresh unavailable"}}"#)
      }
      let since =
        Int(
          URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first {
            $0.name == "sinceSeqId"
          }?.value ?? "0") ?? 0
      return ChatHTTPResponse(
        body:
          "{\"events\":[\(state.value.withLock { $0.events.dropFirst(since).joined(separator: ",") })],\"hasMore\":false}"
      )
    case "/api/indicators":
      let unread = state.value.withLock { $0.unread }
      let indicator = unread ? "{\"\(Self.thread)\":\"unread\"}" : "{}"
      let unreadAt = unread ? "{\"\(Self.thread)\":\"\(Self.date)\"}" : "{}"
      let agents =
        state.value.withLock { $0.unread && !$0.muted } ? "{\"\(Self.agent)\":\"unread\"}" : "{}"
      return ChatHTTPResponse(
        body: "{\"agents\":\(agents),\"threads\":\(indicator),\"unreadAt\":\(unreadAt)}")
    default: throw URLError(.unsupportedURL)
    }
  }

  func remote(kind: String, extra: String = "") {
    state.value.withLock {
      $0.events.append(
        Self.event(kind: kind, id: UUID().uuidString, seq: $0.events.count + 1, extra: extra))
    }
  }

  private static func event(kind: String, id: String, seq: Int, extra: String) -> String {
    "{\"id\":\"\(id.lowercased())\",\"seqId\":\(seq),\"kind\":\"\(kind)\",\"chatThreadId\":\"\(thread)\",\"agentId\":\"\(agent)\",\"createdAt\":\"\(date)\"\(extra)}"
  }

  private static func messageID(_ seq: Int) -> String {
    String(format: "78000000-0000-4000-8000-%012d", seq + 10)
  }

  private static func message(_ seq: Int, type: String, payload: String) -> String {
    "{\"id\":\"\(messageID(seq))\",\"chatThreadId\":\"\(thread)\",\"runId\":null,\"revokesEventId\":null,\"contextType\":null,\"contextId\":null,\"runEventSequenceNumber\":null,\"runEventId\":null,\"seqId\":\(seq),\"createdAt\":\"\(date)\",\"eventType\":\"\(type)\",\"payload\":\(payload)}"
  }
}
