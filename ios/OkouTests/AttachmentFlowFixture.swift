import ChatData
import ChatDataTestSupport
import ChatDomain
import Foundation
import Synchronization
import UIKit
import XCTest

@testable import Okou

final class AttachmentFlowFixture: Sendable {
  static let fileID = "42000000-0000-4000-8000-000000000001"
  static let threadID = "42000000-0000-4000-8000-000000000003"
  struct State: Sendable {
    var uploads = 0
    var preparations: [Data] = []
    var messages: [Data] = []
    var accepted: Data?
    var draft = ComposerDraft()
    var composerDrafts: [String: ComposerDraft] = [:]
    /// The member's server Workflow history; `nil` until a use or import initializes it.
    var recentWorkflowIDs: [String]?
  }
  let state = AttachmentFlowState()
  let http: ChatHTTPFixture

  init(
    failUpload: Bool = false, failSend: Bool = false, acceptBeforeFailure: Bool = false,
    storage: @escaping @Sendable () async -> Void = {},
    creation: @escaping @Sendable () async -> Bool = { true },
    creationResponse: ChatHTTPFixture.Handler? = nil,
    sending: @escaping @Sendable () async -> Void = {},
    draftRead: @escaping @Sendable () async -> Void = {},
    workflows: (@Sendable (URLRequest) async throws -> ChatHTTPResponse)? = nil,
    // `nil` answers from the fixture's member history.
    recentWorkflows: @escaping @Sendable (URLRequest) async throws -> ChatHTTPResponse? = { _ in
      nil
    },
    voiceInput: ChatHTTPFixture.Handler? = nil,
    attachment: ChatAttachment? = nil,
    threadList: ChatHTTPFixture.Handler? = nil,
    connectorSettings: ChatHTTPFixture.Handler? = nil
  ) {
    let state = self.state
    http = ChatHTTPFixture { request in
      let path = request.url?.path ?? ""
      let file =
        attachment
        ?? ChatAttachment(
          id: Self.fileID, filename: "notes.txt", contentType: "text/plain", size: 5,
          url: "artifact://\(Self.fileID)")
      let metadata = try JSONEncoder().encodeString(file)
      if path == "/api/chat-drafts/composer" {
        return try Self.composerDraftResponse(request, path: path, state: state)
      }
      if let response = try await Self.settingsResponse(
        request, path: path, connectorSettings: connectorSettings)
      {
        return response
      }
      switch path {
      case "/api/voice-io/quota", "/api/voice-io/transcribe/segment",
        "/api/voice-io/polish/segments":
        guard let voiceInput else { throw URLError(.unsupportedURL) }
        return try await voiceInput(request)
      case "/api/chat-threads/snapshot", "/api/chat-threads/events", "/api/indicators":
        return try await Self.navigationResponse(request, path: path, threadList: threadList)
      case "/api/workflows/for-composer", "/api/workflows/recent", "/api/workflows/recent/use",
        "/api/workflows/recent/import":
        return try await Self.workflowResponse(
          request, path: path, state: state, workflows: workflows, recent: recentWorkflows)
      case "/api/chat-threads/\(Self.threadID)/composer-draft":
        if request.httpMethod == "PATCH" {
          let draft = try JSONDecoder().decode(ComposerDraft.self, from: chatRequestBody(request))
          state.value.withLock { $0.draft = draft }
          return ChatHTTPResponse(status: 204, body: "")
        }
        await draftRead()
        return try ChatHTTPResponse(
          json: state.value.withLock { $0.draft })
      case "/api/uploads/prepare":
        state.value.withLock { $0.preparations.append(chatRequestBody(request)) }
        let url = "https://\(request.url!.host!)/storage/object"
        return ChatHTTPResponse(
          body: String(metadata.dropLast()) + ",\"uploadUrl\":\"\(url)\",\"uploadHeaders\":{}}")
      case "/storage/object":
        await storage()
        let count = state.value.withLock {
          $0.uploads += 1
          return $0.uploads
        }
        return ChatHTTPResponse(status: failUpload && count == 1 ? 500 : 200, body: "")
      case "/api/uploads/complete": return ChatHTTPResponse(body: metadata)
      case "/api/chat-threads":
        if let creationResponse { return try await creationResponse(request) }
        guard await creation() else {
          return ChatHTTPResponse(
            status: 503, body: "{\"error\":{\"message\":\"Creation failed\"}}")
        }
        return ChatHTTPResponse(
          status: 201, body: "{\"id\":\"\(Self.threadID)\",\"createdAt\":\"2026-10-19T10:00:00Z\"}")
      case let path where path.hasSuffix("/event-snapshot"):
        return ChatHTTPResponse(
          status: 404,
          body:
            "{\"error\":{\"code\":\"CHAT_EVENT_SNAPSHOT_NOT_FOUND\",\"message\":\"No snapshot\"}}")
      case let path where path.hasSuffix("/event-rows"):
        return try Self.historyResponse(request, state: state)
      case "/api/chat-threads/\(Self.threadID)":
        return ChatHTTPResponse(body: "{\"cancellationRecoveryPending\":false}")
      case "/api/chat/events":
        return await Self.sendResponse(
          request, state: state, failSend: failSend,
          acceptBeforeFailure: acceptBeforeFailure, sending: sending)
      default: throw URLError(.unsupportedURL)
      }
    }
  }

  /// Recency mirrors the API's member history: a use moves its Workflows to the front, and an
  /// import initializes only a history that was never initialized.
  private static func workflowResponse(
    _ request: URLRequest, path: String, state: AttachmentFlowState,
    workflows: ChatHTTPFixture.Handler?,
    recent: @Sendable (URLRequest) async throws -> ChatHTTPResponse?
  ) async throws -> ChatHTTPResponse {
    if path == "/api/workflows/for-composer" {
      guard let workflows else { throw URLError(.unsupportedURL) }
      return try await workflows(request)
    }
    if let response = try await recent(request) { return response }
    struct History: Decodable { let workflowIds: [String] }
    var ids = state.value.withLock { $0.recentWorkflowIDs }
    if request.httpMethod == "POST" {
      let used = try JSONDecoder().decode(History.self, from: chatRequestBody(request)).workflowIds
      ids = state.value.withLock { value in
        if path.hasSuffix("/use") {
          var seen = Set<String>()
          value.recentWorkflowIDs = (used + (value.recentWorkflowIDs ?? [])).filter {
            seen.insert($0).inserted
          }
        } else if value.recentWorkflowIDs == nil {
          value.recentWorkflowIDs = used
        }
        return value.recentWorkflowIDs
      }
    }
    let json = try ids.map { try JSONEncoder().encodeString($0) } ?? "null"
    return ChatHTTPResponse(body: #"{"workflowIds":"# + json + "}")
  }

  private static func settingsResponse(
    _ request: URLRequest, path: String, connectorSettings: ChatHTTPFixture.Handler?
  ) async throws -> ChatHTTPResponse? {
    switch path {
    case "/api/chat-connector-overview",
      _
    where path.hasPrefix("/api/connector-accounts/") || path.contains("/connector-access/")
      || path.hasSuffix("/connector-current"):
      guard let connectorSettings else { throw URLError(.unsupportedURL) }
      return try await connectorSettings(request)
    default: return Self.supportResponse(path: path)
    }
  }

  private static func navigationResponse(
    _ request: URLRequest, path: String, threadList: ChatHTTPFixture.Handler?
  ) async throws -> ChatHTTPResponse {
    if let threadList { return try await threadList(request) }
    switch path {
    case "/api/chat-threads/snapshot":
      return ChatHTTPResponse(
        body: #"{"chatThreads":[],"latestEventId":null,"latestSeqId":null}"#)
    case "/api/chat-threads/events":
      return ChatHTTPResponse(body: #"{"events":[],"hasMore":false}"#)
    default:
      return ChatHTTPResponse(body: #"{"threads":{},"unreadAt":{}}"#)
    }
  }

  /// Shared navigation/metadata responses, independent of uploads, drafts and delivery.
  private static func supportResponse(path: String) -> ChatHTTPResponse? {
    switch path {
    case "/api/chat-thread-drafts":
      return ChatHTTPResponse(body: #"{"draftThreadIds":[]}"#)
    case "/api/web/file-url": return ChatHTTPResponse(body: "{}")
    case "/api/remotes/overview":
      return ChatHTTPResponse(
        body:
          #"{"computerUseHosts":[],"cloudBrowserAvailable":true,"cloudBrowserEnabledByDefault":false,"sshHosts":[],"vncHosts":[]}"#
      )
    case "/api/feature-switches": return ChatHTTPResponse(body: #"{"effectiveSwitches":{}}"#)
    case "/api/user-model-preference": return ChatHTTPResponse(body: "{}")
    case "/api/run-models", "/api/model-catalog":
      return ChatHTTPResponse(body: "{\"models\":[],\"routes\":[]}")
    case let path where path.hasSuffix("/connector-selections"):
      return ChatHTTPResponse(body: "{\"selections\":[]}")
    case let path where path.hasSuffix("/metadata"):
      return ChatHTTPResponse(
        body:
          "{\"id\":\"\(Self.threadID)\",\"computerUseHostId\":null,\"cloudBrowserEnabled\":false}"
      )
    default: return nil
    }
  }

  private static func composerDraftResponse(
    _ request: URLRequest, path: String, state: AttachmentFlowState
  ) throws -> ChatHTTPResponse {
    if request.httpMethod == "PATCH" {
      let draft = try JSONDecoder().decode(ComposerDraft.self, from: chatRequestBody(request))
      state.value.withLock { $0.composerDrafts[path] = draft }
      return ChatHTTPResponse(status: 204, body: "")
    }
    let draft = state.value.withLock { $0.composerDrafts[path] ?? ComposerDraft() }
    return try ChatHTTPResponse(
      json: draft)
  }

  private static func historyResponse(
    _ request: URLRequest, state: AttachmentFlowState
  ) throws -> ChatHTTPResponse {
    if let accepted = state.value.withLock({ $0.accepted }) {
      let message = try JSONDecoder().decode(PersistedMessage.self, from: accepted)
      let after =
        URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
        .queryItems?.first { $0.name == "sinceSeqId" }?.value.flatMap(Int.init) ?? 0
      if after >= 1 {
        return ChatHTTPResponse(
          body:
            "{\"rows\":[],\"cursor\":{\"lastEventId\":\"\(message.clientEventId)\",\"lastSeqId\":1},\"hasMore\":false}"
        )
      }
      let document = try JSONEncoder().encodeString(message.userMessage)
      return ChatHTTPResponse(
        body:
          "{\"rows\":[{\"id\":\"\(message.clientEventId)\",\"chatThreadId\":\"\(Self.threadID)\",\"seqId\":1,\"eventType\":\"input.prompt\",\"createdAt\":\"2026-10-19T10:00:00Z\",\"payload\":{\"userMessage\":\(document)}}],\"cursor\":{\"lastEventId\":\"\(message.clientEventId)\",\"lastSeqId\":1},\"hasMore\":false}"
      )
    }
    return ChatHTTPResponse(
      body: "{\"rows\":[],\"cursor\":{\"lastEventId\":null,\"lastSeqId\":0},\"hasMore\":false}")
  }

  private static func sendResponse(
    _ request: URLRequest, state: AttachmentFlowState, failSend: Bool,
    acceptBeforeFailure: Bool, sending: @Sendable () async -> Void
  ) async -> ChatHTTPResponse {
    await sending()
    let failed = state.value.withLock {
      $0.messages.append(chatRequestBody(request))
      if failSend && $0.messages.count == 1 {
        if acceptBeforeFailure { $0.accepted = chatRequestBody(request) }
        return true
      }
      $0.accepted = chatRequestBody(request)
      return false
    }
    return ChatHTTPResponse(
      status: failed ? 503 : 201,
      body: failed
        ? "{\"error\":{\"message\":\"Unknown delivery\"}}"
        : "{\"threadId\":\"\(Self.threadID)\"}")
  }

  @MainActor func conversation(
    storage: ChatDraftStorage? = nil, workflowSource: ComposerWorkflowSource? = nil
  ) -> ConversationStore {
    let sync = ChatSync(client: http.client)
    return ConversationStore(
      thread: ChatThread(
        id: Self.threadID, title: "Attachments",
        createdAt: .now, updatedAt: .now, sortAt: .now),
      sync: sync, commands: ChatCommands(client: http.client, sync: sync),
      graph: makeTestWorkspaceGraph(),
      webURL: http.baseURL,
      messageMarkdown: MessageMarkdownCache(baseURL: http.baseURL),
      isVisible: { false }, didMarkRead: { _ in }, didSend: {}, didFail: { _ in }, didSettle: {},
      workflowSource: workflowSource,
      draftRepository: storage.map { _ in ChatDraftRepository(client: http.client) },
      draftStorage: storage)
  }

  private struct PersistedMessage: Decodable {
    let clientEventId: String
    let userMessage: ChatDraftDocument
  }

  struct Message: Codable {
    let clientEventId: String
    let hasTextContent: Bool
    let userMessage: Document
    struct Document: Codable {
      let version: Int
      let parts: [Part]
    }
    struct Part: Codable {
      let type: String
      let text: String?
      let fileId: String?
      let filenameSnapshot: String?
      let contentType: String?
    }
  }
}

final class AttachmentFlowState: Sendable {
  let value = Mutex(AttachmentFlowFixture.State())
}
