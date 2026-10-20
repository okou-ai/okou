import ChatData
import ChatDomain
import Foundation
import OSLog
import Observation

/// One immutable network/cache scope, with independently observed feature state.
@MainActor @Observable
final class WorkspaceStore {
  private let client: APIClient
  private let sync: ChatSync
  private let commands: ChatCommands
  private let conversationLimit: Int
  let webURL: URL
  let messageMarkdown: MessageMarkdownCache
  private(set) var needsUpgrade = false
  private(set) var isCreating = false
  var error: String?
  var selectedThreadID: String? {
    didSet {
      let previous = selectedConversation
      selectedConversation = selectedThreadID.flatMap { conversation(for: $0) }
      previous?.reconcileActivitySummary()
      selectedConversation?.reconcileActivitySummary()
    }
  }
  var selectedAgentID: String? {
    didSet {
      guard oldValue != selectedAgentID else { return }
      if let selectedAgentID {
        do { try draftStorage?.save(selectedAgentID, key: "active-agent") } catch {
          self.error = "Cannot save the draft's Agent. " + error.localizedDescription
        }
      }
      activateAgentDraft()
    }
  }
  var newChatDraft: String {
    get { newComposer.text }
    set { newComposer.text = newValue }
  }
  var newAttachmentDraft: AttachmentDraftStore { newComposer.attachments }
  private(set) var newComposer: ComposerDraftStore
  private let draftStorage: ChatDraftStorage?
  private let draftRepository: ChatDraftRepository?
  @ObservationIgnored private var agentDrafts: [String: ComposerDraftStore] = [:]
  private var agentDraftTask: Task<Void, Never>?
  private(set) var connectionStatus = RealtimeConnectionStatus.connecting

  @ObservationIgnored lazy var list = ThreadListStore(
    client: client, sync: sync, commands: commands,
    didRefresh: { [weak self] in self?.applyThreads($0) },
    didFail: { [weak self] in self?.handle($0) })
  @ObservationIgnored private var conversations: [String: ConversationStore] = [:]
  @ObservationIgnored private var lastUse: [String: UInt64] = [:]
  private var clock: UInt64 = 0
  private var realtime: RealtimeService?
  private var invalidations: Set<ChatInvalidation> = []
  private var refreshTask: Task<Void, Never>?
  private var creationTask: Task<ChatThread?, Never>?
  private var pruneTask: Task<Void, Never>?
  private var pruneAgain = false
  private var warmingTask: Task<Void, Never>?
  private var warmAgain = false
  private var closed = false
  private var isForeground = false
  private var startupGeneration = UUID()

  init(
    client: APIClient, webURL: URL, cache: ChatCache? = nil, conversationLimit: Int = 8,
    draftStorage: ChatDraftStorage? = nil
  ) {
    self.client = client
    self.draftStorage = draftStorage
    draftRepository = draftStorage.map { _ in ChatDraftRepository(client: client) }
    let sync = ChatSync(client: client, cache: cache)
    self.sync = sync
    let commands = ChatCommands(client: client, sync: sync)
    self.commands = commands
    self.webURL = webURL
    self.messageMarkdown = MessageMarkdownCache(baseURL: webURL)
    self.conversationLimit = max(0, conversationLimit)
    newComposer = ComposerDraftStore(
      target: .unassigned, commands: commands, storage: draftStorage,
      didFail: { _ in })
    do {
      selectedAgentID = try draftStorage?.load("active-agent", as: String.self)
      if selectedAgentID != nil { activateAgentDraft() }
    } catch { self.error = "Cannot restore the draft's Agent. " + error.localizedDescription }
  }

  func start(userID: String, workspaceID: String) async {
    guard !closed, !Task.isCancelled else { return }
    let generation = UUID()
    startupGeneration = generation
    realtime?.stop()
    realtime = nil
    defer {
      if Task.isCancelled, startupGeneration == generation {
        realtime?.stop()
        realtime = nil
      }
    }
    await list.restoreCached()
    guard canContinueStartup(generation) else { return }
    let realtime = RealtimeService(
      userID: userID, workspaceID: workspaceID,
      tokenProvider: { [client] in
        try await client.data("/api/realtime/token", method: "POST", body: Data("{}".utf8)).data
      },
      onChange: { [weak self] in self?.requestRefresh($0) },
      onConnection: { [weak self] in self?.connectionStatus = $0 })
    self.realtime = realtime
    realtime.start()
    await refreshNavigation()
    guard canContinueStartup(generation) else { return }
    await refresh()
  }

  private func canContinueStartup(_ generation: UUID) -> Bool {
    !closed && !needsUpgrade && !Task.isCancelled && startupGeneration == generation
  }

  func refreshNavigation() async {
    await list.refreshNavigation()
    guard !closed, !Task.isCancelled else { return }
    if selectedAgentID == nil {
      selectedAgentID = list.agents.first(where: \.isDefaultAgent)?.agentId
    }
  }

  var currentAgentName: String {
    list.agents.first(where: { $0.agentId == selectedAgentID })?.displayName ?? "Okou"
  }

  private(set) var selectedConversation: ConversationStore?

  func conversation(for id: String) -> ConversationStore? {
    guard !closed, let thread = list.threads.first(where: { $0.id == id }) else { return nil }
    clock &+= 1
    lastUse[id] = clock
    if let conversation = conversations[id] { return conversation }
    let conversation = ConversationStore(
      thread: thread, sync: sync, commands: commands, webURL: webURL,
      messageMarkdown: messageMarkdown,
      isVisible: { [weak self] in self?.isForeground == true && self?.selectedThreadID == id },
      didMarkRead: { [weak self] in self?.list.markRead(id) },
      didSend: { [weak self] in self?.requestRefresh(.threadList) },
      didFail: { [weak self] in self?.handle($0) },
      didSettle: { [weak self] in self?.requestPrune() },
      draftRepository: draftRepository, draftStorage: draftStorage)
    conversations[id] = conversation
    return conversation
  }

  func close() {
    closed = true
    startupGeneration = UUID()
    refreshTask?.cancel()
    creationTask?.cancel()
    pruneTask?.cancel()
    warmingTask?.cancel()
    list.close()
    for conversation in conversations.values { conversation.close() }
    realtime?.stop()
    realtime = nil
    messageMarkdown.clear()
    agentDraftTask?.cancel()
    newComposer.close()
    for composer in agentDrafts.values { composer.close() }
  }

  func setForeground(_ active: Bool) {
    isForeground = active
    selectedConversation?.reconcileActivitySummary()
    if !active {
      Task { [weak self] in await self?.synchronizeDrafts() }
    }
  }

  func synchronizeDrafts() async {
    guard !closed else { return }
    await newComposer.synchronize()
    for conversation in conversations.values { await conversation.composer.synchronize() }
  }

  private func activateAgentDraft() {
    guard !closed, let id = selectedAgentID else { return }
    if let existing = agentDrafts[id] {
      newComposer = existing
    } else {
      let composer = ComposerDraftStore(
        target: .agent(id), commands: commands,
        repository: draftRepository, storage: draftStorage,
        didFail: { [weak self] in self?.handle($0) })
      // Preserve input entered before navigation resolves the default Agent.
      if !isCreating && newComposer.hasContent && agentDrafts.isEmpty {
        newComposer.move(to: composer)
      }
      agentDrafts[id] = composer
      newComposer = composer
    }
    let composer = newComposer
    agentDraftTask = Task { await composer.synchronize() }
  }

  func requestRefresh(_ invalidation: ChatInvalidation = .reconnected) {
    guard !closed, !needsUpgrade else { return }
    invalidations.insert(invalidation)
    guard refreshTask == nil else { return }
    refreshTask = Task { [weak self] in
      guard let self else { return }
      defer { refreshTask = nil }
      while !invalidations.isEmpty && !closed && !needsUpgrade && !Task.isCancelled {
        let batch = invalidations
        invalidations.removeAll()
        await refresh(batch)
      }
    }
  }

  /// Awaitable refresh boundary used by manual refresh and deterministic HTTP tests.
  func refresh(_ batch: Set<ChatInvalidation> = [.reconnected]) async {
    guard !closed, !needsUpgrade, !Task.isCancelled else { return }
    let full = batch.contains(.reconnected)
    if full || batch.contains(.threadList) {
      await list.refresh()
    } else if batch.contains(.readCursor)
      || batch.contains(where: {
        if case .history = $0 { return true }
        return false
      })
    {
      await list.refreshIndicators()
    }
    guard !closed, !needsUpgrade, !Task.isCancelled else { return }
    var ids = Set<String>()
    for invalidation in batch {
      switch invalidation {
      case .history(let id), .detail(let id): ids.insert(id)
      default: break
      }
    }
    if full, let selectedThreadID { ids.insert(selectedThreadID) }
    for id in ids.sorted() {
      // Dormant conversations read their durable state when opened.
      if let conversation = conversations[id] {
        await conversation.refresh()
      } else if selectedThreadID == id {
        await conversation(for: id)?.refresh()
      }
    }
    if full { await synchronizeDrafts() }
    await trimConversations(limit: conversationLimit)
    requestHistoryWarming()
  }

  private func requestHistoryWarming() {
    guard !closed, !needsUpgrade else { return }
    warmAgain = true
    guard warmingTask == nil else { return }
    warmingTask = Task(priority: .utility) { [weak self] in
      guard let self else { return }
      defer { warmingTask = nil }
      repeat {
        // Coalesce startup, indicator updates and bursts of realtime messages.
        do { try await Task.sleep(for: .seconds(1)) } catch { return }
        warmAgain = false
        let recent = list.threads.sorted {
          $0.sortAt == $1.sortAt ? $0.id > $1.id : $0.sortAt > $1.sortAt
        }.prefix(100)
        let candidates = Set(
          recent.map(\.id) + list.threads.filter { $0.indicator != nil }.map(\.id))
        let ids = candidates.filter { conversations[$0] == nil }.sorted()
        do {
          try await sync.warmHistories(threadIDs: ids)
        } catch is CancellationError {
          return
        } catch {
          guard !closed, !Task.isCancelled else { return }
          handle(error)
          Logger(subsystem: "ai.okou.ios", category: "ChatCache")
            .error("Cannot warm chat history: \(error.localizedDescription, privacy: .public)")
        }
      } while warmAgain && !closed && !needsUpgrade && !Task.isCancelled
    }
  }

  func selectChat(_ id: String) {
    guard !closed, let thread = list.threads.first(where: { $0.id == id }) else { return }
    selectedThreadID = id
    selectedAgentID = thread.agentID
  }

  func startNewChat(agentID: String? = nil) {
    guard !isCreating, !needsUpgrade, !closed else { return }
    selectedThreadID = nil
    selectedAgentID =
      agentID ?? selectedAgentID ?? list.agents.first(where: \.isDefaultAgent)?.agentId
    error = nil
  }

  @discardableResult
  func createChat(agentID: String? = nil) async -> ChatThread? {
    guard !isCreating, !needsUpgrade, !closed, !Task.isCancelled else { return nil }
    isCreating = true
    let task = Task<ChatThread?, Never> { [weak self] in
      guard let self else { return nil }
      defer {
        isCreating = false
        creationTask = nil
      }
      do {
        let thread = try await commands.createThread(agentID: agentID)
        try Task.checkCancellation()
        guard !closed else { return nil }
        list.insertCreated(thread)
        selectedThreadID = thread.id
        selectedAgentID = list.threads.first(where: { $0.id == thread.id })?.agentID
        error = nil
        return thread
      } catch is CancellationError {
      } catch {
        guard !closed else { return nil }
        self.error = error.localizedDescription
        handle(error)
      }
      return nil
    }
    creationTask = task
    return await task.value
  }

  func sendNewChat() async {
    let sourceComposer = newComposer
    guard sourceComposer.hasContent, sourceComposer.canSend, newAttachmentDraft.isReady,
      selectedThreadID == nil, !isCreating, !needsUpgrade, !closed
    else {
      return
    }
    guard let created = await createChat(agentID: selectedAgentID), !closed,
      let conversation = conversation(for: created.id)
    else { return }
    sourceComposer.move(to: conversation.composer)
    sourceComposer.requestSync()
    await conversation.send()
  }

  func reduceMemory() async {
    warmingTask?.cancel()
    warmAgain = false
    messageMarkdown.clear()
    for conversation in conversations.values { conversation.measurements.clear() }
    await trimConversations(limit: 0)
  }

  private func requestPrune() {
    guard !closed else { return }
    pruneAgain = true
    guard pruneTask == nil else { return }
    pruneTask = Task { [weak self] in
      guard let self else { return }
      defer { pruneTask = nil }
      repeat {
        pruneAgain = false
        await trimConversations(limit: conversationLimit)
      } while pruneAgain && !closed && !Task.isCancelled
    }
  }

  private func applyThreads(_ threads: [ChatThread]) {
    guard !closed else { return }
    if selectedAgentID == nil { selectedAgentID = threads.first?.agentID }
    for thread in threads { conversations[thread.id]?.thread = thread }
    if let selectedThreadID {
      if let thread = threads.first(where: { $0.id == selectedThreadID }) {
        selectedAgentID = thread.agentID
        selectedConversation = conversation(for: selectedThreadID)
      } else {
        self.selectedThreadID = nil
      }
    }
  }

  private func trimConversations(limit: Int) async {
    let candidates = conversations.keys.sorted { (lastUse[$0] ?? 0) < (lastUse[$1] ?? 0) }
    for id in candidates {
      guard !closed, !Task.isCancelled else { return }
      let removed = !list.threads.contains(where: { $0.id == id })
      guard removed || conversations.count > limit else { continue }
      guard selectedThreadID != id, let conversation = conversations[id], conversation.canRelease
      else { continue }
      guard await sync.releaseHistory(threadID: id), !closed, selectedThreadID != id,
        conversation.canRelease, conversations[id] === conversation
      else { continue }
      conversation.close()
      conversations[id] = nil
      lastUse[id] = nil
    }
  }

  private func handle(_ failure: Error) {
    guard !closed, (failure as? APIClientError)?.statusCode == 426 else { return }
    needsUpgrade = true
    close()
  }
}
