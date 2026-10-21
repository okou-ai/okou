import ChatDomain
import Foundation

/// Workspace-scoped mutations. Read synchronization belongs to ChatSync.
public actor ChatCommands {
  public nonisolated let permissions: ChatPermissions
  let client: APIClient
  public nonisolated let connectorActions: ChatConnectorService
  private let sync: ChatSync
  private var sendingThreads = Set<String>()
  private var writingReadState = false
  private var readStateWaiters: [CheckedContinuation<Void, Never>] = []

  public init(client: APIClient, sync: ChatSync) {
    permissions = ChatPermissions(client: client)
    self.client = client
    connectorActions = ChatConnectorService(client: client)
    self.sync = sync
  }

  public func createThread(
    agentID: String? = nil, modelSelection: ChatModelSelection? = nil,
    reasoningEffort: String? = nil
  ) async throws -> ChatThread {
    async let agentsRequest: [AgentRecord] = client.request("/api/agents")
    let selection: ThreadModelSelection
    if let modelSelection {
      selection = ThreadModelSelection(
        model: modelSelection.model, serviceTier: modelSelection.serviceTier,
        reasoningEffort: reasoningEffort)
    } else {
      async let preference: ModelPreference = client.request("/api/user-model-preference")
      async let models: AvailableRunModels = client.request("/api/run-models")
      async let catalog: ModelCatalog = client.request("/api/model-catalog")
      selection = try await resolveThreadModelSelection(
        preference: preference, availableModels: models, catalog: catalog)
    }
    let agents = try await agentsRequest
    guard
      let agent = agents.first(where: {
        $0.agentId == agentID || (agentID == nil && $0.isDefaultAgent)
      })
    else {
      if agentID != nil { throw ChatError.agentUnavailable }
      throw ChatError.noDefaultAgent
    }
    let body = CreateThreadBody(
      agentId: agent.agentId, clientThreadId: UUID().uuidString,
      eventId: UUID().uuidString, model: selection.model,
      serviceTier: selection.serviceTier,
      reasoningEffort: selection.reasoningEffort)
    let created: CreatedThread = try await client.request(
      "/api/chat-threads", method: "POST", body: JSONEncoder().encode(body))
    return ChatThread(
      id: created.id, agentID: agent.agentId, title: created.title ?? "",
      selectedModel: created.selectedModel, createdAt: created.createdAt,
      updatedAt: created.createdAt, sortAt: created.createdAt,
      pinnedAt: nil, pinOrder: nil,
      modelSettings: selection.model.flatMap { model in
        selection.reasoningEffort.map { [model: ThreadModelSetting(effort: $0)] }
      } ?? [:], serviceTier: selection.serviceTier, indicator: nil)
  }

  public func validateAttachment(_ id: String) async throws {
    _ = try await client.data(
      "/api/web/file-url", query: [URLQueryItem(name: "file_id", value: id)])
  }

  public func uploadAttachment(
    file: URL, filename: String, contentType: String,
    progress: @escaping @Sendable (Double) -> Void = { _ in }
  ) async throws -> ChatAttachment {
    try await ChatAttachmentUpload(client: client).upload(
      file: file, filename: filename, contentType: contentType, progress: progress)
  }

  public func downloadAttachment(
    _ attachment: ChatMessageAttachment, thumbnail: Bool = false
  ) async throws -> ChatAttachmentFile? {
    try await ChatAttachmentDownload(client: client).download(attachment, thumbnail: thumbnail)
  }

  public func send(
    thread: ChatThread, text: String, attachments: [ChatAttachment] = [],
    document: ChatDraftDocument? = nil,
    clientEventID: String = UUID().uuidString,
    chatThreadSortEventID: String = UUID().uuidString,
    modelSelection: ChatModelSelection? = nil, reasoningEffort: String? = nil,
    expectedAgentID: String? = nil
  )
    async throws -> SendReceipt
  {
    let prompt = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !prompt.isEmpty || !attachments.isEmpty || document?.parts.isEmpty == false else {
      throw ChatError.invalidContract("Enter a message before sending.")
    }
    guard UUID(uuidString: clientEventID) != nil else {
      throw ChatError.invalidContract("Invalid message identity.")
    }
    guard sendingThreads.insert(thread.id).inserted else {
      throw ChatError.operationInProgress
    }
    defer { sendingThreads.remove(thread.id) }

    let metadata = try await normalizeMobileSettings(
      threadID: thread.id, expectedAgentID: expectedAgentID)
    if let expectedAgentID, metadata.agentId.lowercased() != expectedAgentID.lowercased() {
      throw ChatError.agentUnavailable
    }
    let body = SendBody(
      agentId: metadata.agentId, threadId: thread.id,
      prompt: prompt.isEmpty
        ? (document?.hasFeedback == true
          ? "(see quoted passages)"
          : (document?.hasTextContent == true ? "(see references)" : "(see attached files)"))
        : prompt,
      clientEventId: clientEventID, chatThreadSortEventId: chatThreadSortEventID,
      userMessage: document
        ?? ChatDraftDocument(
          parts: (prompt.isEmpty
            ? [] : [.object(["type": .string("text"), "text": .string(prompt)])])
            + attachments.map {
              .object([
                "type": .string("file"), "fileId": .string($0.id),
                "filenameSnapshot": .string($0.filename), "contentType": .string($0.contentType),
              ])
            }),
      hasTextContent: !prompt.isEmpty || document?.hasTextContent == true,
      modelSelection: modelSelection,
      reasoningEffort: reasoningEffort)
    do {
      let result: ChatSendResponse = try await client.request(
        "/api/chat/events", method: "POST", body: JSONEncoder().encode(body))
      return SendReceipt(threadID: result.threadId, clientEventID: clientEventID)
    } catch is CancellationError {
      throw CancellationError()
    } catch let error as APIClientError {
      if let status = error.statusCode, (400..<500).contains(status) { throw error }
      throw ChatError.sendUncertain(error.localizedDescription)
    } catch {
      throw ChatError.sendUncertain(error.localizedDescription)
    }
  }

  public func stop(thread: ChatThread) async throws {
    let current = try await sync.history(threadID: thread.id)
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

  @discardableResult
  public func markRead(threadID: String) async throws -> Date? {
    await acquireReadState()
    defer { releaseReadState() }
    try Task.checkCancellation()
    let state: ThreadReadState = try await client.request(
      "/api/chat-threads/\(threadID)/mark-read", method: "POST")
    return state.lastReadAt
  }

  public func markUnread(threadID: String) async throws {
    await acquireReadState()
    defer { releaseReadState() }
    try Task.checkCancellation()
    let _: ThreadReadState = try await client.request(
      "/api/chat-threads/\(threadID)/mark-unread", method: "POST")
  }

  public func markAgentRead(agentID: String) async throws {
    await acquireReadState()
    defer { releaseReadState() }
    try Task.checkCancellation()
    try await client.data(
      "/api/chat-thread-unreads/mark-read", method: "POST",
      body: JSONEncoder().encode(["agentId": agentID]))
  }

  // Actor reentrancy must not let an automatic read finish after a manual unread.
  private func acquireReadState() async {
    if writingReadState {
      await withCheckedContinuation { readStateWaiters.append($0) }
    } else {
      writingReadState = true
    }
  }

  private func releaseReadState() {
    if readStateWaiters.isEmpty {
      writingReadState = false
    } else {
      readStateWaiters.removeFirst().resume()
    }
  }

  public func setPinned(
    threadID: String, pinned: Bool, eventID: String, pinOrder: String? = nil
  ) async throws {
    let action = pinned ? "pin" : "unpin"
    var query = [URLQueryItem(name: "eventId", value: eventID)]
    if pinned, let pinOrder { query.append(URLQueryItem(name: "pinOrder", value: pinOrder)) }
    try await client.data("/api/chat-threads/\(threadID)/\(action)", method: "POST", query: query)
  }

  public func setArchived(threadID: String, archived: Bool) async throws {
    let action = archived ? "archive" : "unarchive"
    try await client.data("/api/chat-threads/\(threadID)/\(action)", method: "POST")
  }

  public func rename(threadID: String, title: String) async throws {
    let body = try JSONEncoder().encode(["title": title])
    try await client.data("/api/chat-threads/\(threadID)/rename", method: "POST", body: body)
  }

  private func normalizeMobileSettings(threadID: String, expectedAgentID: String?) async throws
    -> ThreadMetadata
  {
    let path = "/api/chat-threads/\(threadID)"
    let metadata: ThreadMetadata = try await client.request(path + "/metadata")
    if let expectedAgentID, metadata.agentId.lowercased() != expectedAgentID.lowercased() {
      throw ChatError.agentUnavailable
    }
    if metadata.computerUseHostId != nil || metadata.cloudBrowserEnabled {
      try await client.data(
        path + "/computer-use-host", method: "POST",
        body: JSONEncoder().encode(ComputerAccessBody()))
    }
    let settings: ThreadMetadata = try await client.request(path + "/metadata")
    guard settings.computerUseHostId == nil, !settings.cloudBrowserEnabled else {
      throw ChatError.settingsChanged
    }
    return settings
  }

  private struct CreateThreadBody: Encodable {
    let agentId: String
    let clientThreadId: String
    let eventId: String
    /// Nil is Auto and is sent as an explicit JSON null.
    let model: String?
    let serviceTier: String?
    let reasoningEffort: String?

    enum CodingKeys: String, CodingKey {
      case agentId, clientThreadId, eventId, model, serviceTier, reasoningEffort
    }

    func encode(to encoder: Encoder) throws {
      var container = encoder.container(keyedBy: CodingKeys.self)
      try container.encode(agentId, forKey: .agentId)
      try container.encode(clientThreadId, forKey: .clientThreadId)
      try container.encode(eventId, forKey: .eventId)
      try container.encode(model, forKey: .model)
      try container.encodeIfPresent(serviceTier, forKey: .serviceTier)
      try container.encodeIfPresent(reasoningEffort, forKey: .reasoningEffort)
    }
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
    let userMessage: ChatDraftDocument
    let hasTextContent: Bool
    let modelSelection: ChatModelSelection?
    let reasoningEffort: String?
    enum Keys: String, CodingKey {
      case agentId, threadId, prompt, clientEventId, chatThreadSortEventId, userMessage
      case hasTextContent, computerUseHostId, cloudBrowserEnabled, model, runOptions
    }
    func encode(to encoder: Encoder) throws {
      var container = encoder.container(keyedBy: Keys.self)
      try container.encode(agentId, forKey: .agentId)
      try container.encode(threadId, forKey: .threadId)
      try container.encode(prompt, forKey: .prompt)
      try container.encode(clientEventId, forKey: .clientEventId)
      try container.encode(chatThreadSortEventId, forKey: .chatThreadSortEventId)
      try container.encode(userMessage, forKey: .userMessage)
      try container.encode(hasTextContent, forKey: .hasTextContent)
      if let modelSelection {
        try container.encode(modelSelection.model, forKey: .model)
        var options: [String: String] = [:]
        if modelSelection.serviceTier == "priority" { options["codexServiceTier"] = "fast" }
        if let reasoningEffort { options["reasoningEffort"] = reasoningEffort }
        if !options.isEmpty { try container.encode(options, forKey: .runOptions) }
      }
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
