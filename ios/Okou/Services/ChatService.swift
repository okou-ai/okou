import Foundation
import OSLog

actor ChatService {
  private let client: APIClient
  private let chatEventSchemaVersion = 8
  private let threadEventRebaseThreshold = 100
  private var cache: ChatCache?
  private var histories: [String: CachedHistory] = [:]
  private var readingHistories = Set<String>()
  private var historyWaiters: [String: [CheckedContinuation<Void, Never>]] = [:]
  private var sendingThreads = Set<String>()

  init(client: APIClient) { self.client = client }

  func configureCache(scope: ChatCacheScope, directory: URL? = nil) {
    cache = ChatCache(scope: scope, directory: directory)
    histories.removeAll()
  }

  func cachedThreads() async -> [ChatThread]? {
    guard let cached = await readCachedThreadList() else { return nil }
    return ChatThreadReplay.sidebarOrder(
      ChatThreadReplay.replay(snapshot: cached.snapshot, events: cached.events))
  }

  func cachedHistory(threadID: String) async -> ChatHistory? {
    guard let cached = await readCachedHistory(threadID: threadID) else { return nil }
    return try? ChatEventProjection.history(rows: cached.rows, recovering: false)
  }

  func threads() async throws -> [ChatThread] {
    let cached = await readCachedThreadList()
    var state: ThreadListState
    if let cached {
      state = cached
    } else {
      state = try await fetchThreadSnapshot()
    }
    let previousIDs = Set(
      ChatThreadReplay.replay(snapshot: state.snapshot, events: state.events).map(\.id))
    state = try await catchUpThreadEvents(state)
    if !state.replaced && state.events.count > threadEventRebaseThreshold {
      let rebased: ThreadListState?
      do {
        rebased = try await fetchThreadSnapshot()
      } catch let error as APIClientError where error.statusCode == 401 {
        throw error
      } catch {
        Logger(subsystem: "ai.okou.ios", category: "ChatCache")
          .debug(
            "Skipping chat list snapshot rebase: \(error.localizedDescription, privacy: .public)")
        rebased = nil
      }
      if let rebased { state = try await catchUpThreadEvents(rebased) }
    }
    await persistThreadList(state)
    let current = ChatThreadReplay.sidebarOrder(
      ChatThreadReplay.replay(snapshot: state.snapshot, events: state.events))
    for removedID in previousIDs.subtracting(current.map(\.id)) {
      histories.removeValue(forKey: removedID)
      do {
        try await cache?.deleteHistory(threadID: removedID)
      } catch {
        Logger(subsystem: "ai.okou.ios", category: "ChatCache")
          .error(
            "Cannot remove deleted chat history: \(error.localizedDescription, privacy: .public)")
      }
    }
    let indicators: Indicators? = try? await client.request("/api/indicators")
    return current.map { thread in
      var updated = thread
      updated.indicator = indicators?.threads[thread.id]
      return updated
    }
  }

  private struct ThreadListState {
    var snapshot: [ThreadProjection]
    var snapshotData: Data
    var snapshotCursor: ChatCacheCursor
    var events: [ThreadEvent]
    var newEvents: [ChatCacheEvent]
    var cursor: ChatCacheCursor
    var replaced: Bool
    var cursorFromServerSnapshot: Bool
  }

  private func readCachedThreadList() async -> ThreadListState? {
    guard let cache else { return nil }
    do {
      guard let stored = try await cache.loadThreadList() else { return nil }
      let snapshot = try APIClient.decoder().decode(
        ThreadSnapshotArchive.self, from: stored.snapshot
      ).chatThreads
      let events = try stored.events.map { row in
        let event = try APIClient.decoder().decode(ThreadEvent.self, from: row.data)
        guard event.id == row.id, event.seqId == row.seqID else {
          throw ChatServiceError.invalidContract("Cached chat list event identity is invalid.")
        }
        return event
      }
      var previous = stored.snapshotCursor.seqID
      for event in events {
        guard event.seqId > previous else {
          throw ChatServiceError.invalidContract("Cached chat list event order is invalid.")
        }
        previous = event.seqId
      }
      return ThreadListState(
        snapshot: snapshot, snapshotData: stored.snapshot,
        snapshotCursor: stored.snapshotCursor, events: events, newEvents: [],
        cursor: events.last.map { ChatCacheCursor(eventID: $0.id, seqID: $0.seqId) }
          ?? stored.snapshotCursor,
        replaced: false, cursorFromServerSnapshot: false)
    } catch {
      Logger(subsystem: "ai.okou.ios", category: "ChatCache")
        .error("Cannot read cached chat list: \(error.localizedDescription, privacy: .public)")
      return nil
    }
  }

  private func fetchThreadSnapshot() async throws -> ThreadListState {
    let response = try await client.data("/api/chat-threads/snapshot")
    let snapshot = try Self.decode(ThreadSnapshot.self, from: response.data)
    let archiveData: Data
    let latestEventID: String?
    let latestSeqID: Int?
    switch snapshot {
    case .inline(_, let eventID, let seqID):
      // The inline response is an empty scope on current APIs. Keep the exact
      // projection JSON for a rollback-window response as well.
      guard let object = try JSONSerialization.jsonObject(with: response.data) as? [String: Any],
        let threads = object["chatThreads"]
      else { throw APIClientError.incompatibleData }
      archiveData = try JSONSerialization.data(withJSONObject: ["chatThreads": threads])
      latestEventID = eventID
      latestSeqID = seqID
    case .remote(let url, let eventID, let seqID):
      archiveData = try await client.downloadSnapshot(url)
      latestEventID = eventID
      latestSeqID = seqID
    }
    let projections = try Self.decode(ThreadSnapshotArchive.self, from: archiveData).chatThreads
    let cursor = ChatCacheCursor(eventID: latestEventID, seqID: latestSeqID ?? 0)
    return ThreadListState(
      snapshot: projections, snapshotData: archiveData, snapshotCursor: cursor,
      events: [], newEvents: [], cursor: cursor, replaced: true,
      cursorFromServerSnapshot: true)
  }

  private func catchUpThreadEvents(_ initial: ThreadListState) async throws -> ThreadListState {
    var state = initial
    while true {
      do {
        try await loadThreadEventTail(into: &state)
        return state
      } catch let error as APIClientError where error.statusCode == 410 {
        guard !state.cursorFromServerSnapshot else {
          throw ChatServiceError.invalidContract(
            "Chat list cursor expired immediately after its snapshot.")
        }
        state = try await fetchThreadSnapshot()
      }
    }
  }

  private func loadThreadEventTail(into state: inout ThreadListState) async throws {
    while true {
      let query =
        state.cursor.seqID > 0
        ? [URLQueryItem(name: "sinceSeqId", value: String(state.cursor.seqID))] : []
      let response = try await client.data("/api/chat-threads/events", query: query)
      let page = try Self.decode(ThreadEventsPage.self, from: response.data)
      let rawEvents = try Self.rawArray("events", in: response.data)
      guard page.events.count == rawEvents.count else { throw APIClientError.incompatibleData }
      for (event, data) in zip(page.events, rawEvents) {
        guard event.seqId > state.cursor.seqID,
          !state.events.contains(where: { $0.id == event.id })
        else { throw ChatServiceError.invalidContract("Chat list events are not ordered.") }
        state.events.append(event)
        state.newEvents.append(ChatCacheEvent(id: event.id, seqID: event.seqId, data: data))
        state.cursor = ChatCacheCursor(eventID: event.id, seqID: event.seqId)
      }
      if !page.events.isEmpty { state.cursorFromServerSnapshot = false }
      if !page.hasMore { return }
      if page.events.isEmpty {
        throw ChatServiceError.invalidContract("Chat list cursor did not advance.")
      }
    }
  }

  private func persistThreadList(_ state: ThreadListState) async {
    guard let cache, state.replaced || !state.newEvents.isEmpty else { return }
    do {
      if state.replaced {
        try await cache.replaceThreadList(
          snapshot: state.snapshotData, cursor: state.snapshotCursor, events: state.newEvents)
      } else {
        try await cache.appendThreadEvents(state.newEvents)
      }
    } catch {
      Logger(subsystem: "ai.okou.ios", category: "ChatCache")
        .error("Cannot save chat list cache: \(error.localizedDescription, privacy: .public)")
    }
  }

  private static func decode<Value: Decodable>(_ type: Value.Type, from data: Data) throws -> Value
  {
    do { return try APIClient.decoder().decode(type, from: data) } catch {
      throw APIClientError.incompatibleData
    }
  }

  private static func rawArray(_ key: String, in data: Data) throws -> [Data] {
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      let values = object[key] as? [Any]
    else { throw APIClientError.incompatibleData }
    return try values.map { value in
      guard JSONSerialization.isValidJSONObject(value) else {
        throw APIClientError.incompatibleData
      }
      return try JSONSerialization.data(withJSONObject: value)
    }
  }

  func history(threadID: String) async throws -> ChatHistory {
    // Actor methods can interleave at every network/cache await. Serialize each
    // thread's catch-up and durable cursor update, including calls from Stop.
    if !readingHistories.insert(threadID).inserted {
      await withCheckedContinuation { historyWaiters[threadID, default: []].append($0) }
    }
    defer {
      if var waiters = historyWaiters[threadID], !waiters.isEmpty {
        let next = waiters.removeFirst()
        historyWaiters[threadID] = waiters.isEmpty ? nil : waiters
        next.resume()
      } else {
        readingHistories.remove(threadID)
      }
    }
    try Task.checkCancellation()
    return try await loadHistory(threadID: threadID)
  }

  func createThread(agentID: String? = nil) async throws -> ChatThread {
    async let agentsRequest: [AgentRecord] = client.request("/api/agents")
    async let preferenceRequest: ModelPreference = client.request("/api/user-model-preference")
    async let modelsRequest: AvailableRunModels = client.request("/api/run-models")
    async let catalogRequest: ModelCatalog = client.request("/api/model-catalog")
    let (agents, preference, availableModels, catalog) = try await (
      agentsRequest, preferenceRequest, modelsRequest, catalogRequest
    )
    guard
      let agent = agents.first(where: {
        $0.agentId == agentID || (agentID == nil && $0.isDefaultAgent)
      })
    else {
      if agentID != nil { throw ChatServiceError.agentUnavailable }
      throw ChatServiceError.noDefaultAgent
    }
    // A saved selection of a retired model resolves to its active replacement.
    let savedModel = preference.selectedModel.flatMap { catalog.resolve($0) }
    let usableSavedModel = savedModel.flatMap { model in
      availableModels.models.contains { $0.model == model && $0.hasUsableRoute() }
        ? model : nil
    }
    let model = usableSavedModel ?? availableModels.defaultModel
    let serviceTier = preference.serviceTier.flatMap { tier in
      usableSavedModel != nil
        && availableModels.models.contains {
          $0.model == model && $0.supportsServiceTier(tier, catalog: catalog)
        }
        ? tier : nil
    }
    let body = CreateThreadBody(
      agentId: agent.agentId, clientThreadId: UUID().uuidString,
      eventId: UUID().uuidString, model: model,
      serviceTier: serviceTier,
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
      return SendReceipt(threadID: result.threadId, clientEventID: clientEventID)
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

  func setPinned(threadID: String, pinned: Bool) async throws {
    let action = pinned ? "pin" : "unpin"
    try await client.data("/api/chat-threads/\(threadID)/\(action)", method: "POST")
  }

  func setArchived(threadID: String, archived: Bool) async throws {
    let action = archived ? "archive" : "unarchive"
    try await client.data("/api/chat-threads/\(threadID)/\(action)", method: "POST")
  }

  func rename(threadID: String, title: String) async throws {
    let body = try JSONEncoder().encode(["title": title])
    try await client.data("/api/chat-threads/\(threadID)/rename", method: "POST", body: body)
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
    let cached = await readCachedHistory(threadID: threadID)
    var history: CachedHistory
    if let cached {
      history = cached
    } else {
      history = try await loadSnapshot(threadID: threadID)
    }
    history = try await catchUpHistory(threadID: threadID, initial: history)
    if await persistHistory(history, threadID: threadID) {
      history.newRows = []
      history.replaced = false
    }
    history.cursorFromServerSnapshot = false
    histories[threadID] = history
    let detail: ThreadDetail = try await client.request("/api/chat-threads/\(threadID)")
    return try ChatEventProjection.history(
      rows: history.rows, recovering: detail.cancellationRecoveryPending)
  }

  private func loadSnapshot(threadID: String) async throws -> CachedHistory {
    let snapshot: EventSnapshot
    do {
      snapshot = try await client.request(
        "/api/chat-threads/\(threadID)/event-snapshot")
    } catch let error as APIClientError
      where error.statusCode == 404
      && error.serverCode == "CHAT_EVENT_SNAPSHOT_NOT_FOUND"
    {
      return CachedHistory(
        rows: [], rawRows: [], newRows: [], cursor: .start, replaced: true,
        cursorFromServerSnapshot: true)
    }
    let data = try await client.downloadSnapshot(snapshot.url)
    // URLSession decompresses HTTP Content-Encoding: gzip before delivering data.
    guard let text = String(data: data, encoding: .utf8) else {
      throw ChatServiceError.invalidContract("The history snapshot is not UTF-8 NDJSON.")
    }
    if !text.isEmpty && !text.hasSuffix("\n") {
      throw ChatServiceError.invalidContract("The history snapshot is not NDJSON.")
    }
    var rows: [ChatEventRow] = []
    var rawRows: [ChatCacheEvent] = []
    for line in text.split(separator: "\n")
    where !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      let raw = Data(line.utf8)
      let row = try Self.decode(ChatEventRow.self, from: raw)
      rows.append(row)
      rawRows.append(ChatCacheEvent(id: row.id, seqID: row.seqId, data: raw))
    }
    try Self.validate(rows: rows, threadID: threadID, after: 0)
    let cursor = rows.last.map { EventCursor(lastEventId: $0.id, lastSeqId: $0.seqId) } ?? .start
    guard snapshot.cursor.isValid, snapshot.cursor == cursor else {
      throw ChatServiceError.invalidContract("The history snapshot does not match its cursor.")
    }
    return CachedHistory(
      rows: rows, rawRows: rawRows, newRows: rawRows, cursor: cursor, replaced: true,
      cursorFromServerSnapshot: true)
  }

  private func readCachedHistory(threadID: String) async -> CachedHistory? {
    if let memory = histories[threadID] { return memory }
    guard let cache else { return nil }
    do {
      guard let stored = try await cache.loadHistory(threadID: threadID),
        stored.schemaVersion == chatEventSchemaVersion
      else { return nil }
      let rows = try stored.rows.map { entry in
        let row = try Self.decode(ChatEventRow.self, from: entry.data)
        guard row.id == entry.id, row.seqId == entry.seqID else {
          throw ChatServiceError.invalidContract("Cached chat event identity is invalid.")
        }
        return row
      }
      try Self.validate(rows: rows, threadID: threadID, after: 0)
      guard stored.cursor.eventID == rows.last?.id,
        stored.cursor.seqID == (rows.last?.seqId ?? 0)
      else { throw ChatServiceError.invalidContract("Cached chat history cursor is invalid.") }
      return CachedHistory(
        rows: rows, rawRows: stored.rows, newRows: [],
        cursor: EventCursor(lastEventId: stored.cursor.eventID, lastSeqId: stored.cursor.seqID),
        replaced: false, cursorFromServerSnapshot: false)
    } catch {
      Logger(subsystem: "ai.okou.ios", category: "ChatCache")
        .error("Cannot read cached history: \(error.localizedDescription, privacy: .public)")
      return nil
    }
  }

  private func catchUpHistory(threadID: String, initial: CachedHistory) async throws
    -> CachedHistory
  {
    var history = initial
    while true {
      do {
        try await loadHistoryTail(threadID: threadID, into: &history)
        return history
      } catch let error as APIClientError where error.statusCode == 410 {
        guard !history.cursorFromServerSnapshot else {
          throw ChatServiceError.invalidContract(
            "Chat history cursor expired immediately after its snapshot.")
        }
        history = try await loadSnapshot(threadID: threadID)
      }
    }
  }

  private func loadHistoryTail(threadID: String, into history: inout CachedHistory) async throws {
    var confirmFreshTail = history.replaced
    while true {
      var query = [
        URLQueryItem(name: "sinceSeqId", value: String(history.cursor.lastSeqId)),
        URLQueryItem(name: "limit", value: "50"),
      ]
      if let eventID = history.cursor.lastEventId {
        query.append(URLQueryItem(name: "sinceEventId", value: eventID))
      }
      let response = try await client.data(
        "/api/chat-threads/\(threadID)/event-rows", query: query)
      let page = try Self.decode(EventRowsPage.self, from: response.data)
      let rawRows = try Self.rawArray("rows", in: response.data)
      guard page.rows.count == rawRows.count else { throw APIClientError.incompatibleData }
      try Self.validate(rows: page.rows, threadID: threadID, after: history.cursor.lastSeqId)
      let existingIDs = Set(history.rows.map(\.id))
      guard page.rows.allSatisfy({ !existingIDs.contains($0.id) }) else {
        throw ChatServiceError.invalidContract("Chat history repeats an existing event identity.")
      }
      guard page.cursor.isValid,
        page.cursor
          == (page.rows.last.map { EventCursor(lastEventId: $0.id, lastSeqId: $0.seqId) }
            ?? history.cursor),
        !page.hasMore || !page.rows.isEmpty
      else { throw ChatServiceError.invalidContract("Chat history cursor is inconsistent.") }
      for (row, raw) in zip(page.rows, rawRows) {
        let entry = ChatCacheEvent(id: row.id, seqID: row.seqId, data: raw)
        history.rawRows.append(entry)
        history.newRows.append(entry)
      }
      history.rows.append(contentsOf: page.rows)
      history.cursor = page.cursor
      if !page.rows.isEmpty { history.cursorFromServerSnapshot = false }
      let shouldContinue = page.hasMore || confirmFreshTail
      confirmFreshTail = false
      if !shouldContinue { return }
    }
  }

  private func persistHistory(_ history: CachedHistory, threadID: String) async -> Bool {
    guard let cache else { return false }
    guard history.replaced || !history.newRows.isEmpty else { return true }
    let cursor = ChatCacheCursor(
      eventID: history.cursor.lastEventId, seqID: history.cursor.lastSeqId)
    do {
      if history.replaced {
        try await cache.replaceHistory(
          threadID: threadID, rows: history.rawRows, cursor: cursor,
          schemaVersion: chatEventSchemaVersion)
      } else {
        try await cache.appendHistory(
          threadID: threadID, rows: history.newRows, cursor: cursor,
          schemaVersion: chatEventSchemaVersion)
      }
      return true
    } catch {
      Logger(subsystem: "ai.okou.ios", category: "ChatCache")
        .error("Cannot save chat history cache: \(error.localizedDescription, privacy: .public)")
      return false
    }
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

  private struct CachedHistory: Sendable {
    var rows: [ChatEventRow]
    var rawRows: [ChatCacheEvent]
    var newRows: [ChatCacheEvent]
    var cursor: EventCursor
    var replaced: Bool
    var cursorFromServerSnapshot: Bool
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
