import ChatDomain
import Foundation

/// Workspace-scoped mutations. Read synchronization belongs to ChatSync.
public actor ChatCommands {
  public nonisolated let artifacts: ChatArtifacts
  public nonisolated let voiceInput: VoiceInputClient
  public nonisolated let permissions: ChatPermissions
  public nonisolated let batchPermissions: ChatBatchPermissions
  let client: APIClient
  /// Approval cards (mail drafts, shell access) call the API directly with this client.
  public nonisolated var approvalClient: APIClient { client }
  public nonisolated let connectorActions: ChatConnectorService
  private let sync: ChatSync
  private var sendingThreads = Set<String>()
  private var writingReadState = false
  private var readStateWaiters: [CheckedContinuation<Void, Never>] = []

  public init(client: APIClient, sync: ChatSync) {
    voiceInput = VoiceInputClient(client: client)
    artifacts = ChatArtifacts(client: client)
    permissions = ChatPermissions(client: client)
    batchPermissions = ChatBatchPermissions(client: client)
    self.client = client
    connectorActions = ChatConnectorService(client: client)
    self.sync = sync
  }

  public func createThread(
    modelSelection: ChatModelSelection? = nil,
    reasoningEffort: String? = nil, composerOptions: ChatComposerOptions? = nil
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
    guard let agent = agents.first(where: \.isDefaultAgent) else { throw ChatError.noDefaultAgent }
    let body = CreateThreadBody(
      agentId: agent.agentId, clientThreadId: UUID().uuidString,
      eventId: UUID().uuidString, model: selection.model,
      serviceTier: selection.serviceTier,
      reasoningEffort: selection.reasoningEffort, composerOptions: composerOptions)
    let created: CreatedThread = try await client.request(
      "/api/chat-threads", method: "POST", body: JSONEncoder().encode(body))
    if let options = composerOptions, options.chatAccountAccess {
      let access = ChatComposerAccess(client: client)
      for choice in options.initialConnectorAccessOverrides {
        try await access.setConnectorAccess(
          target: choice.target, connectionID: choice.connectionId,
          threadID: created.id, enabled: choice.enabled)
      }
      for selection in options.connectorSelections {
        try await access.setCurrentAccount(
          target: selection.target, connectionID: selection.connectionId, threadID: created.id)
      }
    }
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
    let uploaded = try await ChatAttachmentUpload(client: client).upload(
      file: file, filename: filename, contentType: contentType, progress: progress)
    // Upload is already committed. A failed disposable cache must not turn it into a failed upload.
    if let retained = try? ChatAttachmentFile.retaining(
      file, filename: uploaded.filename, attachmentID: uploaded.id)
    {
      artifacts.retainUpload(retained, id: uploaded.id)
    }
    return uploaded
  }

  public func downloadAttachment(
    _ attachment: ChatMessageAttachment, thumbnail: Bool = false
  ) async throws -> ChatAttachmentFile? {
    let artifact = ChatArtifact(
      source: .file(attachment.downloadID), filename: attachment.filename,
      contentType: attachment.contentType, size: attachment.size)
    if thumbnail { return try await artifacts.thumbnail(artifact, webURL: client.baseURL).1 }
    return try await artifacts.download(artifact).1
  }

  public nonisolated func closeFileCache() { artifacts.closeFileCache() }

  public func send(
    thread: ChatThread, text: String, attachments: [ChatAttachment] = [],
    document: ChatDraftDocument? = nil,
    clientEventID: String = UUID().uuidString,
    chatThreadSortEventID: String = UUID().uuidString,
    modelSelection: ChatModelSelection? = nil, reasoningEffort: String? = nil,
    computerAccess: ChatComputerAccess? = nil,
    expectedAgentID: String? = nil
  )
    async throws -> SendReceipt
  {
    let prompt = text.trimmingCharacters(in: .whitespacesAndNewlines)
    let document = document?.trimmingWhitespace()
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

    let metadata = try await loadThreadSettings(
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
      reasoningEffort: reasoningEffort,
      computerAccess: computerAccess
        ?? ChatComputerAccess(
          computerUseHostId: metadata.computerUseHostId,
          cloudBrowserEnabled: metadata.cloudBrowserEnabled))
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
    await sync.changeReadState(.invalidated)
    do {
      let state: ThreadReadState = try await client.request(
        "/api/chat-threads/\(threadID)/mark-read", method: "POST")
      await sync.changeReadState(.read(threadID: threadID, through: state.lastReadAt))
      return state.lastReadAt
    } catch {
      await sync.changeReadState(.invalidated)
      throw error
    }
  }

  public func markUnread(threadID: String) async throws {
    await acquireReadState()
    defer { releaseReadState() }
    try Task.checkCancellation()
    await sync.changeReadState(.invalidated)
    do {
      let _: ThreadReadState = try await client.request(
        "/api/chat-threads/\(threadID)/mark-unread", method: "POST")
      await sync.changeReadState(.unread(threadID: threadID))
    } catch {
      await sync.changeReadState(.invalidated)
      throw error
    }
  }

  public func markAgentRead(agentID: String) async throws {
    await acquireReadState()
    defer { releaseReadState() }
    try Task.checkCancellation()
    let baseline = await sync.cachedIndicators()
    await sync.changeReadState(.invalidated)
    do {
      try await client.data(
        "/api/chat-thread-unreads/mark-read", method: "POST",
        body: JSONEncoder().encode(["agentId": agentID]))
      await sync.changeReadState(.agentRead(agentID: agentID, baseline: baseline))
    } catch {
      await sync.changeReadState(.invalidated)
      throw error
    }
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
    var query = [URLQueryItem(name: "eventId", value: eventID)]
    if pinned, let pinOrder { query.append(URLQueryItem(name: "pinOrder", value: pinOrder)) }
    if pinned {
      try await client.data("/api/chat-threads/\(threadID)/pin", method: "POST", query: query)
    } else {
      try await client.data("/api/chat-threads/\(threadID)/unpin", method: "POST", query: query)
    }
  }

  public func setMuted(threadID: String, muted: Bool, eventID: String) async throws {
    let query = [URLQueryItem(name: "eventId", value: eventID)]
    if muted {
      try await client.data("/api/chat-threads/\(threadID)/mute", method: "POST", query: query)
    } else {
      try await client.data("/api/chat-threads/\(threadID)/unmute", method: "POST", query: query)
    }
  }

  public func setArchived(threadID: String, archived: Bool, eventID: String? = nil) async throws {
    let query = eventID.map { [URLQueryItem(name: "eventId", value: $0)] } ?? []
    if archived {
      try await client.data("/api/chat-threads/\(threadID)/archive", method: "POST", query: query)
    } else {
      try await client.data("/api/chat-threads/\(threadID)/unarchive", method: "POST", query: query)
    }
  }

  public func rename(threadID: String, title: String, eventID: String) async throws {
    let body = try JSONEncoder().encode(["title": title, "eventId": eventID])
    try await client.data("/api/chat-threads/\(threadID)/rename", method: "POST", body: body)
  }

  private func loadThreadSettings(threadID: String, expectedAgentID: String?) async throws
    -> ThreadMetadata
  {
    let metadata: ThreadMetadata = try await client.request(
      "/api/chat-threads/\(threadID)/metadata")
    if let expectedAgentID, metadata.agentId.lowercased() != expectedAgentID.lowercased() {
      throw ChatError.agentUnavailable
    }
    return metadata
  }

  private struct CreateThreadBody: Encodable {
    let agentId: String
    let clientThreadId: String
    let eventId: String
    /// Nil is Auto and is sent as an explicit JSON null.
    let model: String?
    let serviceTier: String?
    let reasoningEffort: String?
    let composerOptions: ChatComposerOptions?

    enum CodingKeys: String, CodingKey {
      case agentId, clientThreadId, eventId, model, serviceTier, reasoningEffort
      case connectorSelections, connectorSelectionPolicy, initialRemoteAccessOverrides
    }

    func encode(to encoder: Encoder) throws {
      var container = encoder.container(keyedBy: CodingKeys.self)
      try container.encode(agentId, forKey: .agentId)
      try container.encode(clientThreadId, forKey: .clientThreadId)
      try container.encode(eventId, forKey: .eventId)
      try container.encode(model, forKey: .model)
      try container.encodeIfPresent(serviceTier, forKey: .serviceTier)
      try container.encodeIfPresent(reasoningEffort, forKey: .reasoningEffort)
      if composerOptions?.chatAccountAccess != true {
        try container.encodeIfPresent(
          composerOptions?.connectorSelections, forKey: .connectorSelections)
        if composerOptions?.connectorSelections.isEmpty == false {
          try container.encode("required", forKey: .connectorSelectionPolicy)
        }
      }
      try container.encodeIfPresent(
        composerOptions?.initialRemoteAccessOverrides, forKey: .initialRemoteAccessOverrides)
    }
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
    let computerAccess: ChatComputerAccess
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
      try container.encode(computerAccess.computerUseHostId, forKey: .computerUseHostId)
      try container.encode(computerAccess.cloudBrowserEnabled, forKey: .cloudBrowserEnabled)
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
