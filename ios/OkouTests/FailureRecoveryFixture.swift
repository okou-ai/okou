import ChatData
import ChatDataTestSupport
import ChatDomain
import Foundation
import Synchronization
import XCTest

@testable import Okou

final class FailureRecoveryFixture: Sendable {
  struct State {
    var rows: [String]
    var lastID = FailureRecoveryFixture.failureID
    var model = "codex-model"
    var metadataStatus = 200
    var accounts = ModelHTTPFixtures.subscriptions.replacingOccurrences(
      of: "\"remainingPercent\":80", with: "\"remainingPercent\":0"
    )
    .replacingOccurrences(of: "\"usedPercent\":20", with: "\"usedPercent\":100")
    var sends: [Data] = []
    var sendStatus = 200
    var persistSend = true
    var resetOutcome = "reset"
    var resetKeys: [String] = []
    var resetGate: ModelResponseGate?
    var resetRequested: (@Sendable () -> Void)?
    var accountGate: ModelResponseGate?
    var accountRequested: (@Sendable () -> Void)?
    var accountStatus = 200
    var billingAdmin = true
    var canBuyCredits = true
    var credits = 0
    var draft = ComposerDraft()
  }
  let state: FailureRecoveryState
  let http: ChatHTTPFixture
  static let runID = "99000000-0000-4000-8000-000000000090"
  static let failureID = "99000000-0000-4000-8000-000000000003"

  init(
    reason: String? = "execution_timeout", error: String = "Time limit reached",
    draft: ComposerDraft = ComposerDraft()
  ) {
    let payload = try! JSONSerialization.data(withJSONObject: [
      "error": error, "failureReason": reason.map { $0 as Any } ?? NSNull(),
    ])
    let rows = [
      Self.row(
        1, type: "input.prompt",
        payload:
          #"{"userMessage":{"version":1,"parts":[{"type":"text","text":"Original question"}]}}"#),
      Self.row(2, type: "output.message", payload: #"{"content":"Already generated content."}"#),
      Self.row(3, type: "run.failed", payload: String(decoding: payload, as: UTF8.self)),
    ]
    var initial = State(rows: rows)
    initial.draft = draft
    let state = FailureRecoveryState(initial)
    self.state = state
    http = ChatHTTPFixture { request in
      let path = request.url!.path
      let threadPath = "/api/chat-threads/\(ModelHTTPFixtures.threadID)"
      switch path {
      case threadPath + "/event-snapshot":
        return ChatHTTPResponse(
          status: 404,
          body: #"{"error":{"code":"CHAT_EVENT_SNAPSHOT_NOT_FOUND","message":"No snapshot"}}"#)
      case threadPath + "/event-rows":
        let since =
          URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?
          .first { $0.name == "sinceSeqId" }?.value.flatMap(Int.init) ?? 0
        return state.value.withLock { value in
          let last = value.rows.count
          let id = value.lastID
          return ChatHTTPResponse(
            body:
              "{\"rows\":[\(value.rows.dropFirst(since).joined(separator: ","))],\"cursor\":{\"lastEventId\":\"\(id)\",\"lastSeqId\":\(last)},\"hasMore\":false}"
          )
        }
      case threadPath:
        if request.httpMethod == "PATCH" {
          let draft = try JSONDecoder().decode(ComposerDraft.self, from: chatRequestBody(request))
          state.value.withLock { $0.draft = draft }
          return ChatHTTPResponse(status: 204, body: "")
        }
        return ChatHTTPResponse(body: #"{"cancellationRecoveryPending":false}"#)
      case threadPath + "/draft":
        return ChatHTTPResponse(
          body: String(
            decoding: try JSONEncoder().encode(state.value.withLock { $0.draft }), as: UTF8.self))
      case "/api/web/file-url":
        return ChatHTTPResponse(body: #"{"url":"https://file.example.invalid/draft"}"#)
      case "/api/uploads/prepare":
        return ChatHTTPResponse(status: 503, body: #"{"error":{"message":"Upload unavailable"}}"#)
      case threadPath + "/mark-read":
        return ChatHTTPResponse(body: #"{"lastReadAt":"2030-01-01T00:00:00Z"}"#)
      case threadPath + "/connector-selections":
        return ChatHTTPResponse(body: #"{"selections":[]}"#)
      case threadPath + "/metadata":
        return state.value.withLock { value in
          value.metadataStatus == 200
            ? ChatHTTPResponse(
              body: ModelHTTPFixtures.metadata.replacingOccurrences(
                of: "codex-model", with: value.model))
            : ChatHTTPResponse(
              status: value.metadataStatus,
              body: #"{"error":{"message":"Model selection unavailable"}}"#)
        }
      case threadPath + "/model-selection":
        let body = try XCTUnwrap(
          JSONSerialization.jsonObject(with: chatRequestBody(request)) as? [String: Any])
        state.value.withLock { $0.model = body["model"] as? String ?? "auto" }
        return ChatHTTPResponse(status: 204, body: "")
      case "/api/chat/events":
        let data = chatRequestBody(request)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        return state.value.withLock { value in
          value.sends.append(data)
          if value.persistSend {
            let id = body["clientEventId"] as! String
            let document = try! JSONSerialization.data(withJSONObject: [
              "userMessage": body["userMessage"]!
            ])
            value.rows.append(
              Self.row(
                value.rows.count + 1, type: "input.prompt",
                payload: String(decoding: document, as: UTF8.self), id: id))
            value.lastID = id
          }
          return value.sendStatus == 200
            ? ChatHTTPResponse(body: "{\"threadId\":\"\(ModelHTTPFixtures.threadID)\"}")
            : ChatHTTPResponse(
              status: value.sendStatus, body: #"{"error":{"message":"Response lost"}}"#)
        }
      case "/api/me/3rd-party-subscriptions":
        let (gate, requested) = state.value.withLock { ($0.accountGate, $0.accountRequested) }
        requested?()
        if let gate { await gate.wait() }
        return state.value.withLock {
          $0.accountStatus == 200
            ? ChatHTTPResponse(body: $0.accounts)
            : ChatHTTPResponse(
              status: $0.accountStatus, body: #"{"error":{"message":"Accounts unavailable"}}"#)
        }
      case "/api/billing/status":
        return state.value.withLock {
          ChatHTTPResponse(
            body: "{\"canBuyCredits\":\($0.canBuyCredits),\"credits\":\($0.credits)}")
        }
      case "/api/org":
        return state.value.withLock {
          ChatHTTPResponse(body: "{\"role\":\"\($0.billingAdmin ? "admin" : "member")\"}")
        }
      default:
        if path.hasSuffix("/subscription-reset") {
          let body = try XCTUnwrap(
            JSONSerialization.jsonObject(with: chatRequestBody(request)) as? [String: String])
          let (gate, requested) = state.value.withLock { value in
            value.resetKeys.append(body["idempotencyKey"]!)
            return (value.resetGate, value.resetRequested)
          }
          requested?()
          if let gate { await gate.wait() }
          return state.value.withLock { value in
            value.resetOutcome == "failure"
              ? ChatHTTPResponse(status: 503, body: #"{"error":{"message":"Reset unavailable"}}"#)
              : ChatHTTPResponse(body: "{\"outcome\":\"\(value.resetOutcome)\"}")
          }
        }
        return try XCTUnwrap(ModelHTTPFixtures.response(path), "Unhandled request: \(path)")
      }
    }
  }

  @MainActor func conversation(cache: ChatCache? = nil, draftStorage: ChatDraftStorage? = nil) async
    -> (ConversationStore, ChatModelStore)
  {
    let resource = ChatModelStore(client: http.client, webURL: http.baseURL, didFail: { _ in })
    let thread = ChatThread(
      id: ModelHTTPFixtures.threadID, agentID: ModelHTTPFixtures.agentID,
      title: "Failure recovery", selectedModel: "codex-model", createdAt: .now, updatedAt: .now,
      sortAt: .now)
    let selection = ChatModelSelectionStore(models: resource, thread: thread)
    await selection.open()
    let sync = ChatSync(client: http.client, cache: cache)
    let conversation = ConversationStore(
      thread: thread, sync: sync, commands: ChatCommands(client: http.client, sync: sync),
      webURL: http.baseURL, messageMarkdown: MessageMarkdownCache(baseURL: http.baseURL),
      isVisible: { false }, didMarkRead: { _ in }, didSend: {}, didFail: { _ in }, didSettle: {},
      modelSelection: selection,
      draftRepository: ChatDraftRepository(client: http.client), draftStorage: draftStorage)
    await conversation.refresh()
    await conversation.composer.synchronize()
    await conversation.refreshFailureAccounts()
    return (conversation, resource)
  }

  static func id(_ seq: Int) -> String { String(format: "99000000-0000-4000-8000-%012d", seq) }
  static func row(_ seq: Int, type: String, payload: String, id: String? = nil) -> String {
    "{\"id\":\"\(id ?? Self.id(seq))\",\"chatThreadId\":\"\(ModelHTTPFixtures.threadID)\",\"runId\":\"\(runID)\",\"seqId\":\(seq),\"createdAt\":\"2026-10-20T00:00:00Z\",\"eventType\":\"\(type)\",\"payload\":\(payload)}"
  }
}

final class FailureRecoveryState: Sendable {
  let value: Mutex<FailureRecoveryFixture.State>
  init(_ state: FailureRecoveryFixture.State) { value = Mutex(state) }
}
