import Foundation

actor ChatService {
  private let client: APIClient
  private let eventHeaders = ["X-Chat-Event-Schema-Version": "7"]
  private var histories: [String: CachedHistory] = [:]
  private var sendingThreads = Set<String>()

  init(client: APIClient) { self.client = client }

  func threads() async throws -> [ChatThread] {
    // A compacted snapshot plus its authoritative tail also handles deleted chats.
    for attempt in 0..<2 {
      do {
        let snapshot: ThreadSnapshot = try await client.request("/api/chat-threads/snapshot")
        var byID = Dictionary(uniqueKeysWithValues: snapshot.chatThreads.map { ($0.id, $0.thread) })
        var cursor = snapshot.latestSeqId
        while true {
          let query = cursor.map { [URLQueryItem(name: "sinceSeqId", value: String($0))] } ?? []
          let page: ThreadEventsPage = try await client.request(
            "/api/chat-threads/events", query: query)
          for event in page.events {
            guard event.seqId > (cursor ?? 0) else {
              throw ChatServiceError.invalidContract("Chat list events are not ordered.")
            }
            Self.apply(event, to: &byID)
            cursor = event.seqId
          }
          if !page.hasMore { break }
          if page.events.isEmpty {
            throw ChatServiceError.invalidContract("Chat list cursor did not advance.")
          }
        }
        let indicators: Indicators = try await client.request("/api/indicators")
        return byID.values.map { thread in
          var updated = thread
          updated.indicator = indicators.threads[thread.id]
          return updated
        }.sorted(by: Self.threadOrder)
      } catch let error as APIClientError where error.statusCode == 410 && attempt == 0 {
        continue
      }
    }
    throw ChatServiceError.invalidContract("Chat list changed during refresh. Refresh again.")
  }

  func history(threadID: String) async throws -> ChatHistory {
    try await loadHistory(threadID: threadID)
  }

  func createThread() async throws -> ChatThread {
    async let agentsRequest: [AgentRecord] = client.request("/api/agents")
    async let preferenceRequest: ModelPreference = client.request("/api/user-model-preference")
    async let policiesRequest: ModelPolicies = client.request("/api/model-policies")
    let (agents, preference, policies) = try await (
      agentsRequest, preferenceRequest, policiesRequest
    )
    guard let agent = agents.first(where: \.isDefaultAgent) else {
      throw ChatServiceError.noDefaultAgent
    }
    let model =
      preference.selectedModel
      ?? policies.policies.first(where: { $0.isDefault && $0.routeStatus == "valid" })?.model
      ?? policies.workspaceDefaultModel
    guard let model else { throw ChatServiceError.noDefaultModel }
    let body = CreateThreadBody(
      agentId: agent.agentId, clientThreadId: UUID().uuidString,
      eventId: UUID().uuidString, model: model,
      serviceTier: preference.selectedModel == model ? preference.serviceTier : nil,
      reasoningEffort: preference.modelSettings?[model]?.effort)
    let created: CreatedThread = try await client.request(
      "/api/chat-threads", method: "POST", body: JSONEncoder().encode(body))
    return ChatThread(
      id: created.id, agentID: agent.agentId, title: created.title ?? "",
      selectedModel: created.selectedModel, createdAt: created.createdAt,
      updatedAt: created.createdAt, sortAt: created.createdAt,
      pinnedAt: nil, pinOrder: nil, indicator: nil)
  }

  func send(thread: ChatThread, text: String, clientEventID: String = UUID().uuidString)
    async throws -> SendReceipt
  {
    let prompt = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !prompt.isEmpty else {
      throw ChatServiceError.invalidContract("Enter a message before sending.")
    }
    guard UUID(uuidString: clientEventID) != nil else {
      throw ChatServiceError.invalidContract("Invalid message identity.")
    }
    guard sendingThreads.insert(thread.id).inserted else {
      throw ChatServiceError.operationInProgress
    }
    defer { sendingThreads.remove(thread.id) }

    let metadata = try await normalizeMobileSettings(threadID: thread.id)
    let body = SendBody(
      agentId: metadata.agentId, threadId: thread.id, prompt: prompt,
      clientEventId: clientEventID, chatThreadSortEventId: UUID().uuidString,
      userMessage: .init(parts: [.init(text: prompt)]))
    do {
      let result: ChatSendResponse = try await client.request(
        "/api/chat/events", method: "POST", body: JSONEncoder().encode(body))
      return SendReceipt(
        threadID: result.threadId, runID: result.runId, clientEventID: clientEventID)
    } catch is CancellationError {
      throw CancellationError()
    } catch let error as APIClientError {
      if let status = error.statusCode, (400..<500).contains(status) { throw error }
      throw ChatServiceError.sendUncertain(error.localizedDescription)
    } catch {
      throw ChatServiceError.sendUncertain(error.localizedDescription)
    }
  }

  func stop(thread: ChatThread) async throws {
    let current = try await history(threadID: thread.id)
    // Stop is explicit. Changing saved settings does not revoke an admitted run.
    for eventID in current.queuedEventIDs {
      let body = RevokeBody(
        agentId: thread.agentID, threadId: thread.id,
        revokesEventId: eventID, clientEventId: UUID().uuidString)
      let _: ChatSendResponse = try await client.request(
        "/api/chat/events", method: "POST", body: JSONEncoder().encode(body))
    }
    for runID in current.activeRunIDs {
      let body = InterruptBody(
        agentId: thread.agentID, threadId: thread.id,
        interruptsRunId: runID, clientEventId: UUID().uuidString)
      let _: ChatSendResponse = try await client.request(
        "/api/chat/events", method: "POST", body: JSONEncoder().encode(body))
    }
  }

  func markRead(threadID: String) async throws {
    try await client.data("/api/chat-threads/\(threadID)/mark-read", method: "POST")
  }

  private func normalizeMobileSettings(threadID: String) async throws -> ThreadMetadata {
    let path = "/api/chat-threads/\(threadID)"
    let selections: ConnectorSelections = try await client.request(path + "/connector-selections")
    for selection in selections.selections {
      try await client.data(
        path + "/connector-selections", method: "DELETE",
        body: JSONEncoder().encode(selection.target))
    }
    let metadata: ThreadMetadata = try await client.request(path + "/metadata")
    if metadata.computerUseHostId != nil || metadata.cloudBrowserEnabled {
      try await client.data(
        path + "/computer-use-host", method: "POST",
        body: JSONEncoder().encode(ComputerAccessBody()))
    }
    async let verifiedSelections: ConnectorSelections = client.request(
      path + "/connector-selections")
    async let verifiedMetadata: ThreadMetadata = client.request(path + "/metadata")
    let (accounts, settings) = try await (verifiedSelections, verifiedMetadata)
    guard accounts.selections.isEmpty, settings.computerUseHostId == nil,
      !settings.cloudBrowserEnabled
    else {
      throw ChatServiceError.settingsChanged
    }
    return settings
  }

  private func loadHistory(threadID: String) async throws -> ChatHistory {
    for attempt in 0..<2 {
      do {
        var history: CachedHistory
        if let cached = histories[threadID] {
          history = cached
        } else {
          history = try await loadSnapshot(threadID: threadID)
        }
        while true {
          var query = [
            URLQueryItem(name: "sinceSeqId", value: String(history.cursor.lastSeqId)),
            URLQueryItem(name: "limit", value: "50"),
          ]
          if let eventID = history.cursor.lastEventId {
            query.append(URLQueryItem(name: "sinceEventId", value: eventID))
          }
          let page: EventRowsPage = try await client.request(
            "/api/chat-threads/\(threadID)/event-rows", query: query, headers: eventHeaders)
          try Self.validate(rows: page.rows, threadID: threadID, after: history.cursor.lastSeqId)
          guard page.cursor.isValid,
            page.cursor
              == (page.rows.last.map { EventCursor(lastEventId: $0.id, lastSeqId: $0.seqId) }
                ?? history.cursor),
            !page.hasMore || !page.rows.isEmpty
          else {
            throw ChatServiceError.invalidContract("Chat history cursor is inconsistent.")
          }
          history.rows.append(contentsOf: page.rows)
          history.cursor = page.cursor
          if !page.hasMore { break }
        }
        let detail: ThreadDetail = try await client.request("/api/chat-threads/\(threadID)")
        // Concurrent refreshes may finish in either order; never replace a newer tail.
        if let newer = histories[threadID], newer.cursor.lastSeqId > history.cursor.lastSeqId {
          history = newer
        }
        let result = try ChatEventProjection.history(
          rows: history.rows, recovering: detail.cancellationRecoveryPending)
        histories[threadID] = history
        return result
      } catch let error as APIClientError where error.statusCode == 410 && attempt == 0 {
        histories[threadID] = nil
      }
    }
    throw ChatServiceError.invalidContract("Chat history changed during refresh. Refresh again.")
  }

  private func loadSnapshot(threadID: String) async throws -> CachedHistory {
    let snapshot: EventSnapshot
    do {
      snapshot = try await client.request(
        "/api/chat-threads/\(threadID)/event-snapshot", headers: eventHeaders)
    } catch let error as APIClientError where error.statusCode == 404 {
      return CachedHistory(rows: [], cursor: .start)
    }
    let data = try await client.downloadSnapshot(snapshot.url)
    // URLSession decompresses HTTP Content-Encoding: gzip before delivering data.
    guard let text = String(data: data, encoding: .utf8) else {
      throw ChatServiceError.invalidContract("The history snapshot is not UTF-8 NDJSON.")
    }
    var rows: [ChatEventRow] = []
    let decoder = APIClient.decoder()
    for line in text.split(separator: "\n")
    where !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      do { rows.append(try decoder.decode(ChatEventRow.self, from: Data(line.utf8))) } catch {
        throw APIClientError.incompatibleData
      }
    }
    try Self.validate(rows: rows, threadID: threadID, after: 0)
    let cursor = rows.last.map { EventCursor(lastEventId: $0.id, lastSeqId: $0.seqId) } ?? .start
    guard snapshot.cursor.isValid, snapshot.cursor == cursor else {
      throw ChatServiceError.invalidContract("The history snapshot does not match its cursor.")
    }
    return CachedHistory(rows: rows, cursor: cursor)
  }

  private static func validate(rows: [ChatEventRow], threadID: String, after: Int) throws {
    var previous = after
    var identities = Set<String>()
    for row in rows {
      guard row.chatThreadId == threadID, row.seqId > previous, identities.insert(row.id).inserted
      else {
        throw ChatServiceError.invalidContract("Chat history contains an invalid event sequence.")
      }
      previous = row.seqId
    }
  }

  private static func apply(_ event: ThreadEvent, to threads: inout [String: ChatThread]) {
    if event.kind == .deleted {
      threads[event.chatThreadId] = nil
      return
    }
    if event.kind == .created {
      threads[event.chatThreadId] = ChatThread(
        id: event.chatThreadId, agentID: event.agentId,
        title: event.title ?? "", selectedModel: event.selectedModel, createdAt: event.createdAt,
        updatedAt: event.createdAt, sortAt: event.createdAt, pinnedAt: nil, pinOrder: nil,
        indicator: nil)
      return
    }
    guard var thread = threads[event.chatThreadId] else { return }
    thread.updatedAt = event.createdAt
    switch event.kind {
    case .renamed: thread.title = event.title ?? ""
    case .modelSelectionUpdated: thread.selectedModel = event.selectedModel
    case .pinned:
      thread.pinnedAt = event.createdAt
      thread.pinOrder = event.pinOrder
    case .unpinned:
      thread.pinnedAt = nil
      thread.pinOrder = nil
    case .sortTouched:
      if let order = event.pinOrder {
        thread.pinOrder = order
      } else {
        thread.sortAt = event.createdAt
      }
    default: break
    }
    threads[event.chatThreadId] = thread
  }

  private static func threadOrder(_ left: ChatThread, _ right: ChatThread) -> Bool {
    if (left.pinnedAt != nil) != (right.pinnedAt != nil) { return left.pinnedAt != nil }
    if left.pinnedAt != nil, let leftOrder = left.pinOrder, let rightOrder = right.pinOrder,
      leftOrder != rightOrder
    {
      return leftOrder < rightOrder
    }
    if left.sortAt != right.sortAt { return left.sortAt > right.sortAt }
    return left.id < right.id
  }

  private struct CachedHistory: Sendable {
    var rows: [ChatEventRow]
    var cursor: EventCursor
  }
  private struct CreateThreadBody: Encodable {
    let agentId: String
    let clientThreadId: String
    let eventId: String
    let model: String
    let serviceTier: String?
    let reasoningEffort: String?
  }
  private struct ComputerAccessBody: Encodable {
    func encode(to encoder: Encoder) throws {
      var container = encoder.container(keyedBy: Keys.self)
      try container.encodeNil(forKey: .computerUseHostId)
      try container.encode(false, forKey: .cloudBrowserEnabled)
    }
    enum Keys: String, CodingKey { case computerUseHostId, cloudBrowserEnabled }
  }
  private struct SendBody: Encodable {
    let agentId: String
    let threadId: String
    let prompt: String
    let clientEventId: String
    let chatThreadSortEventId: String
    let userMessage: Document
    struct Document: Encodable {
      let version = 1
      let parts: [Part]
      struct Part: Encodable {
        let type = "text"
        let text: String
      }
    }
    enum Keys: String, CodingKey {
      case agentId, threadId, prompt, clientEventId, chatThreadSortEventId, userMessage
      case hasTextContent, computerUseHostId, cloudBrowserEnabled
    }
    func encode(to encoder: Encoder) throws {
      var container = encoder.container(keyedBy: Keys.self)
      try container.encode(agentId, forKey: .agentId)
      try container.encode(threadId, forKey: .threadId)
      try container.encode(prompt, forKey: .prompt)
      try container.encode(clientEventId, forKey: .clientEventId)
      try container.encode(chatThreadSortEventId, forKey: .chatThreadSortEventId)
      try container.encode(userMessage, forKey: .userMessage)
      try container.encode(true, forKey: .hasTextContent)
      try container.encodeNil(forKey: .computerUseHostId)
      try container.encode(false, forKey: .cloudBrowserEnabled)
    }
  }
  private struct InterruptBody: Encodable {
    let agentId: String
    let threadId: String
    let interruptsRunId: String
    let clientEventId: String
  }
  private struct RevokeBody: Encodable {
    let agentId: String
    let threadId: String
    let revokesEventId: String
    let clientEventId: String
  }
}
