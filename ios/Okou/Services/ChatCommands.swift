import Foundation

/// Workspace-scoped mutations. Read synchronization belongs to ChatSync.
actor ChatCommands {
  private let client: APIClient
  private let sync: ChatSync
  private var sendingThreads = Set<String>()

  init(client: APIClient, sync: ChatSync) {
    self.client = client
    self.sync = sync
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
      if agentID != nil { throw ChatError.agentUnavailable }
      throw ChatError.noDefaultAgent
    }
    let selection = resolveThreadModelSelection(
      preference: preference, availableModels: availableModels, catalog: catalog)
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
      pinnedAt: nil, pinOrder: nil, indicator: nil)
  }

  func send(thread: ChatThread, text: String, clientEventID: String = UUID().uuidString)
    async throws -> SendReceipt
  {
    let prompt = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !prompt.isEmpty else {
      throw ChatError.invalidContract("Enter a message before sending.")
    }
    guard UUID(uuidString: clientEventID) != nil else {
      throw ChatError.invalidContract("Invalid message identity.")
    }
    guard sendingThreads.insert(thread.id).inserted else {
      throw ChatError.operationInProgress
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
      throw ChatError.sendUncertain(error.localizedDescription)
    } catch {
      throw ChatError.sendUncertain(error.localizedDescription)
    }
  }

  func stop(thread: ChatThread) async throws {
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
