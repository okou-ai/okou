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
    var metadataGate: ModelResponseGate?
    var metadataRequested: (@Sendable () -> Void)?
    var modelSaveStatus = 204
    var modelSaveGate: ModelResponseGate?
    var modelSaveRequested: (@Sendable () -> Void)?
    var threadEvents: [String] = []
    var threadEventsGate: ModelResponseGate?
    var threadEventsRequested: (@Sendable () -> Void)?
    var failNextSend = false
    var markReadStatus = 200
    var markReadGate: ModelResponseGate?
    var markReadRequested: (@Sendable () -> Void)?
    var accounts = ModelHTTPFixtures.subscriptions.replacingOccurrences(
      of: "\"remainingPercent\":80", with: "\"remainingPercent\":0"
    )
    .replacingOccurrences(of: "\"usedPercent\":20", with: "\"usedPercent\":100")
    var sends: [Data] = []
    var stopWrites = 0
    var sendStatus = 200
    var persistSend = true
    var resetOutcome = "reset"
    var resetKeys: [String] = []
    var resetGate: ModelResponseGate?
    var resetRequested: (@Sendable () -> Void)?
    var accountGate: ModelResponseGate?
    var accountRequested: (@Sendable () -> Void)?
    var accountStatus = 200
    var accountStatusAfterReset: Int?
    var billingStatus = 200
    var billingGate: ModelResponseGate?
    var billingRequested: (@Sendable () -> Void)?
    var billingCancelled: (@Sendable () -> Void)?
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
      case "/api/chat-threads/snapshot":
        return ChatHTTPResponse(
          body: """
            {"chatThreads":[{"id":"\(ModelHTTPFixtures.threadID)","agentId":"\(ModelHTTPFixtures.agentID)","title":"Failure recovery","selectedModel":"codex-model","modelSettings":{"codex-model":{"effort":"max"}},"createdAt":"2026-10-20T00:00:00Z","updatedAt":"2026-10-20T00:00:00Z","sortAt":"2026-10-20T00:00:00Z"}],"latestEventId":null,"latestSeqId":0}
            """)
      case "/api/chat-threads/events":
        let since =
          URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?
          .first { $0.name == "sinceSeqId" }?.value.flatMap(Int.init) ?? 0
        let (response, gate, requested) = state.value.withLock { value in
          let response = ChatHTTPResponse(
            body:
              "{\"events\":[\(value.threadEvents.dropFirst(since).joined(separator: ","))],\"hasMore\":false}"
          )
          let gate = value.threadEventsGate
          let requested = value.threadEventsRequested
          value.threadEventsGate = nil
          value.threadEventsRequested = nil
          return (response, gate, requested)
        }
        requested?()
        if let gate { await gate.wait() }
        return response
      case "/api/indicators":
        return ChatHTTPResponse(body: #"{"agents":{},"threads":{},"unreadAt":{}}"#)
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
        let (gate, requested) = state.value.withLock { value in
          let gate = value.markReadGate
          let requested = value.markReadRequested
          value.markReadGate = nil
          value.markReadRequested = nil
          return (gate, requested)
        }
        requested?()
        if let gate { await gate.wait() }
        let status = state.value.withLock { $0.markReadStatus }
        return ChatHTTPResponse(
          status: status,
          body: status == 200
            ? #"{"lastReadAt":"2030-01-01T00:00:00Z"}"#
            : #"{"error":{"message":"Read receipt unavailable"}}"#)
      case threadPath + "/connector-selections":
        return ChatHTTPResponse(body: #"{"selections":[]}"#)
      case threadPath + "/metadata":
        let (response, gate, requested) = state.value.withLock { value in
          let response =
            value.metadataStatus == 200
            ? ChatHTTPResponse(
              body: ModelHTTPFixtures.metadata.replacingOccurrences(
                of: "codex-model", with: value.model))
            : ChatHTTPResponse(
              status: value.metadataStatus,
              body: #"{"error":{"message":"Model selection unavailable"}}"#)
          let gate = value.metadataGate
          let requested = value.metadataRequested
          value.metadataGate = nil
          value.metadataRequested = nil
          return (response, gate, requested)
        }
        requested?()
        if let gate { await gate.wait() }
        return response
      case threadPath + "/model-selection":
        let body = try XCTUnwrap(
          JSONSerialization.jsonObject(with: chatRequestBody(request)) as? [String: Any])
        let (status, gate, requested) = state.value.withLock { value in
          value.model = body["model"] as? String ?? "auto"
          return (value.modelSaveStatus, value.modelSaveGate, value.modelSaveRequested)
        }
        requested?()
        if let gate { await gate.wait() }
        return ChatHTTPResponse(
          status: status,
          body: status == 204 ? "" : #"{"error":{"message":"Save response unavailable"}}"#)
      case "/api/chat/events":
        let data = chatRequestBody(request)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        return state.value.withLock { value in
          if body["interruptsRunId"] != nil || body["revokesEventId"] != nil {
            value.stopWrites += 1
            return ChatHTTPResponse(
              status: 503, body: #"{"error":{"message":"Stop response unavailable"}}"#)
          }
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
            if value.failNextSend {
              value.failNextSend = false
              let seq = value.rows.count + 1
              value.rows.append(
                Self.row(
                  seq, type: "run.failed",
                  payload: #"{"error":"Unavailable","failureReason":"provider_server_error"}"#))
              value.lastID = Self.id(seq)
            }
          }
          return value.sendStatus == 200
            ? ChatHTTPResponse(body: "{\"threadId\":\"\(ModelHTTPFixtures.threadID)\"}")
            : ChatHTTPResponse(
              status: value.sendStatus, body: #"{"error":{"message":"Response lost"}}"#)
        }
      case "/api/me/3rd-party-subscriptions":
        let (response, gate, requested) = state.value.withLock { value in
          let response =
            value.accountStatus == 200
            ? ChatHTTPResponse(body: value.accounts)
            : ChatHTTPResponse(
              status: value.accountStatus, body: #"{"error":{"message":"Accounts unavailable"}}"#)
          let gate = value.accountGate
          let requested = value.accountRequested
          value.accountGate = nil
          value.accountRequested = nil
          return (response, gate, requested)
        }
        requested?()
        if let gate { await gate.wait() }
        return response
      case "/api/billing/status":
        let (response, gate, requested, cancelled) = state.value.withLock { value in
          let response =
            value.billingStatus == 200
            ? ChatHTTPResponse(
              body: "{\"canBuyCredits\":\(value.canBuyCredits),\"credits\":\(value.credits)}")
            : ChatHTTPResponse(
              status: value.billingStatus, body: #"{"error":{"message":"Billing unavailable"}}"#)
          let gate = value.billingGate
          let requested = value.billingRequested
          let cancelled = value.billingCancelled
          value.billingGate = nil
          value.billingRequested = nil
          value.billingCancelled = nil
          return (response, gate, requested, cancelled)
        }
        requested?()
        return await withTaskCancellationHandler {
          if let gate { await gate.wait() }
          return response
        } onCancel: {
          cancelled?()
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
            if let status = value.accountStatusAfterReset { value.accountStatus = status }
            return value.resetOutcome == "failure"
              ? ChatHTTPResponse(status: 503, body: #"{"error":{"message":"Reset unavailable"}}"#)
              : ChatHTTPResponse(body: "{\"outcome\":\"\(value.resetOutcome)\"}")
          }
        }
        return try XCTUnwrap(ModelHTTPFixtures.response(path), "Unhandled request: \(path)")
      }
    }
  }

  @MainActor func conversation(
    cache: ChatCache? = nil, draftStorage: ChatDraftStorage? = nil,
    isVisible: @escaping @MainActor () -> Bool = { false }
  ) async -> (ConversationStore, ChatModelStore) {
    let resource = ChatModelStore(
      client: http.client, webURL: http.baseURL, readRetrySleep: { _ in }, didFail: { _ in })
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
      isVisible: isVisible, didMarkRead: { _ in }, didSend: {}, didFail: { _ in }, didSettle: {},
      modelSelection: selection,
      draftRepository: ChatDraftRepository(client: http.client), draftStorage: draftStorage)
    await conversation.refresh()
    await conversation.composer.synchronize()
    await conversation.refreshFailureAccounts()
    return (conversation, resource)
  }

  static func id(_ seq: Int) -> String { String(format: "99000000-0000-4000-8000-%012d", seq) }
  static func threadEvent(_ seq: Int, kind: String, fields: String) -> String {
    "{\"id\":\"\(id(1000 + seq))\",\"seqId\":\(seq),\"kind\":\"\(kind)\",\"chatThreadId\":\"\(ModelHTTPFixtures.threadID)\",\"agentId\":\"\(ModelHTTPFixtures.agentID)\",\"createdAt\":\"2026-10-20T00:00:01Z\",\(fields)}"
  }

  static func row(_ seq: Int, type: String, payload: String, id: String? = nil) -> String {
    "{\"id\":\"\(id ?? Self.id(seq))\",\"chatThreadId\":\"\(ModelHTTPFixtures.threadID)\",\"runId\":\"\(runID)\",\"seqId\":\(seq),\"createdAt\":\"2026-10-20T00:00:00Z\",\"eventType\":\"\(type)\",\"payload\":\(payload)}"
  }
}

final class FailureRecoveryState: Sendable {
  let value: Mutex<FailureRecoveryFixture.State>
  init(_ state: FailureRecoveryFixture.State) { value = Mutex(state) }
}
