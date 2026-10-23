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
  private(set) var chatLinkError: String?
  private(set) var threadFeedback: ChatThreadFeedback?
  private var chatLinkRequestID = UUID()
  @ObservationIgnored private var chatLinkThreadID: String?
  var selectedThreadID: String? {
    didSet {
      let previous = selectedConversation
      selectedConversation = selectedThreadID.flatMap { conversation(for: $0) }
      previous?.reconcileVisibility()
      selectedConversation?.reconcileVisibility()
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

  @ObservationIgnored lazy var modelStore = ChatModelStore(
    client: client, webURL: webURL, didFail: { [weak self] in self?.handle($0) })
  @ObservationIgnored lazy var composerWorkflows = ComposerWorkflowSource(
    client: client, storage: draftStorage, didFail: { [weak self] in self?.handle($0) })
  @ObservationIgnored lazy var newModelSelection = ChatModelSelectionStore(models: modelStore)
  @ObservationIgnored lazy var search = ChatSearchStore(
    sync: sync, didFail: { [weak self] in self?.handle($0) })

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
    newComposer.setForeground(isForeground)
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
      didMarkRead: { [weak self] watermark in self?.list.markRead(id, through: watermark) },
      didSend: { [weak self] in self?.requestRefresh(.threadList) },
      didFail: { [weak self] in self?.handle($0) },
      didSettle: { [weak self] in self?.requestPrune() },
      modelSelection: ChatModelSelectionStore(models: modelStore, thread: thread),
      workflowSource: composerWorkflows,
      draftRepository: draftRepository, draftStorage: draftStorage,
      didRequestNewChat: { [weak self] in self?.startNewChat(agentID: thread.agentID) })
    conversation.composer.setForeground(isForeground)
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
    modelStore.close()
    composerWorkflows.close()
    newModelSelection.close()
    list.close()
    threadFeedback = nil
    search.close()
    for conversation in conversations.values { conversation.close() }
    realtime?.stop()
    realtime = nil
    messageMarkdown.clear()
    agentDraftTask?.cancel()
    newComposer.close()
    for composer in agentDrafts.values { composer.close() }
  }

  func setForeground(_ active: Bool) {
    guard !closed, isForeground != active else { return }
    isForeground = active
    newComposer.setForeground(active)
    for composer in agentDrafts.values { composer.setForeground(active) }
    for conversation in conversations.values { conversation.composer.setForeground(active) }
    selectedConversation?.reconcileVisibility()
    if active {
      (selectedConversation?.composer ?? newComposer).requestSync()
    }
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
    composer.setForeground(isForeground)
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
    if modelStore.active && (full || batch.contains(.runModels) || batch.contains(.modelPreference))
    {
      await modelStore.refresh()
    }
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
    if full || batch.contains(.readCursor), let selectedThreadID { ids.insert(selectedThreadID) }
    for id in ids.sorted() {
      // Dormant conversations read their durable state when opened.
      if let conversation = conversations[id] {
        await conversation.refresh()
      } else if selectedThreadID == id {
        await conversation(for: id)?.refresh()
      }
    }
    if modelStore.configuration != nil && (full || batch.contains(.threadList)) {
      await selectedConversation?.modelSelection?.refresh()
    }
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
    chatLinkRequestID = UUID()
    chatLinkThreadID = nil
    let reselected = selectedThreadID == id
    selectedThreadID = id
    selectedAgentID = thread.agentID
    selectedConversation?.setAutomaticReadSuppressed(false, resetReadWatermark: true)
    if reselected { requestRefresh(.history(threadID: id)) }
  }

  func dismissChatLinkError() { chatLinkError = nil }

  func openChatLink(_ destination: ChatLinkDestination) async -> Bool {
    guard !closed, !needsUpgrade, !Task.isCancelled else { return false }
    let requestID = UUID()
    chatLinkRequestID = requestID
    chatLinkThreadID = nil
    chatLinkError = nil
    defer {
      if chatLinkRequestID == requestID {
        chatLinkThreadID = nil
        requestPrune()
      }
    }
    func ownsRequest() -> Bool {
      !closed && !needsUpgrade && !Task.isCancelled && chatLinkRequestID == requestID
    }
    do {
      let id: String
      let runID: String?
      switch destination {
      case .thread(let threadID, let sourceRunID):
        id = threadID
        runID = sourceRunID
      case .workflow(let workflowID):
        let threadID = try await client.workflowChatThreadID(workflowID)
        guard ownsRequest() else { return false }
        guard let threadID else {
          chatLinkError = "This workflow's chat is no longer available."
          return false
        }
        id = threadID
        runID = nil
      }
      if !list.threads.contains(where: { $0.id == id }) {
        await list.refresh(waitForCurrent: true)
        guard ownsRequest(), list.error == nil else { return false }
      }
      guard ownsRequest() else { return false }
      // Keep the destination resident while its history resolves the run anchor.
      chatLinkThreadID = id
      guard let conversation = conversation(for: id) else {
        chatLinkError = "This chat is no longer available in this workspace."
        return false
      }
      if let runID {
        if !conversation.revealRun(runID) {
          await conversation.refresh(waitForCurrent: true)
          guard ownsRequest() else { return false }
          _ = conversation.revealRun(runID)
        }
      }
      guard ownsRequest() else { return false }
      selectChat(id)
      return true
    } catch is CancellationError {
      return false
    } catch {
      guard ownsRequest() else { return false }
      chatLinkError = error.localizedDescription
      handle(error)
      return false
    }
  }

  func openSearchResult(_ id: String) async -> Bool {
    guard !closed, !needsUpgrade else { return false }
    let searchID = search.requestID
    guard search.ownsPresentation(searchID) else { return false }
    search.setOpeningError(nil)
    let needsRefresh = !list.threads.contains(where: { $0.id == id })
    if needsRefresh { await list.refresh(waitForCurrent: true) }
    guard !closed, !Task.isCancelled else { return false }
    guard search.ownsPresentation(searchID) else { return false }
    guard !needsRefresh || list.error == nil else { return false }
    guard list.threads.contains(where: { $0.id == id }) else {
      search.setOpeningError("This chat is no longer available. Refresh and try again.")
      return false
    }
    // Like the PWA, message hits open the chat at its existing reading position.
    selectChat(id)
    search.dismiss()
    return true
  }

  func setRead(_ thread: ChatThread, read: Bool) async {
    let conversation = conversations[thread.id]
    if !read { conversation?.setAutomaticReadSuppressed(true) }
    let succeeded = await list.setRead(thread, read: read)
    if read || !succeeded { conversation?.setAutomaticReadSuppressed(false) }
  }

  func dismissThreadFeedback(_ id: UUID) {
    if threadFeedback?.id == id { threadFeedback = nil }
  }

  @discardableResult
  func setArchived(
    _ id: String, archived: Bool, leaveDetail: Bool = false,
    restoreOnUndo: Bool = false, reopenOnSuccess: Bool = false,
    eventID: String = UUID().uuidString.lowercased()
  ) async -> Bool {
    guard !closed, !needsUpgrade, list.canArchiveChats, list.canUpdate(id),
      let thread = list.threads.first(where: { $0.id == id })
    else { return false }
    let leaving = archived && leaveDetail && selectedThreadID == id
    // Creation already owns the next navigation when its response arrives.
    guard !isCreating || (!leaving && !reopenOnSuccess) else { return false }
    let restore = leaving || restoreOnUndo
    let succeeded = await list.setArchived(thread, archived: archived, eventID: eventID) {
      // The list owns the write, so leaving the detail cannot cancel it.
      if leaving { self.startNewChat(agentID: thread.agentID) }
    }
    guard !closed, !needsUpgrade else { return false }
    if succeeded {
      if reopenOnSuccess { selectChat(id) }
      let message =
        archived
        ? (thread.isMuted
          ? "Chat archived. It will stay archived while muted."
          : "Chat archived. A new reply will bring it back.")
        : "Chat unarchived."
      threadFeedback = ChatThreadFeedback(
        threadID: id, message: message, actionTitle: "Undo", requiresNavigation: restore
      ) {
        [weak self] in
        guard let self else { return }
        await self.setArchived(id, archived: !archived, reopenOnSuccess: restore)
      }
    } else {
      threadFeedback = ChatThreadFeedback(
        threadID: id, message: list.error ?? "The archive change was not saved.",
        actionTitle: "Retry", persists: true, requiresNavigation: reopenOnSuccess
      ) { [weak self] in
        await self?.setArchived(
          id, archived: archived, restoreOnUndo: restore,
          reopenOnSuccess: reopenOnSuccess, eventID: eventID)
      }
    }
    return succeeded
  }

  func setMuted(_ id: String, muted: Bool, markRead: Bool = true) async {
    guard !closed, !needsUpgrade, list.canMute(id) else { return }
    let succeeded = await list.setMuted(id, muted: muted, markRead: markRead)
    guard !closed, !needsUpgrade else { return }
    if succeeded {
      let message =
        muted
        ? "Chat muted. Notifications and unread badges are off; tasks keep running."
        : "Chat unmuted. Notifications and unread badges are on."
      let canUndo = muted || list.canMuteChats
      threadFeedback = ChatThreadFeedback(
        threadID: id, message: message, actionTitle: canUndo ? "Undo" : nil
      ) { [weak self] in
        // Undo restores mute state without clearing unread replies, like the PWA.
        await self?.setMuted(id, muted: !muted, markRead: false)
      }
    } else {
      threadFeedback = ChatThreadFeedback(
        threadID: id, message: list.error ?? "The mute change was not saved.",
        actionTitle: "Retry", persists: true
      ) { [weak self] in
        await self?.setMuted(id, muted: muted, markRead: markRead)
      }
    }
  }

  func startNewChat(agentID: String? = nil) {
    guard !isCreating, !needsUpgrade, !closed else { return }
    chatLinkRequestID = UUID()
    chatLinkThreadID = nil
    selectedThreadID = nil
    selectedAgentID =
      agentID ?? selectedAgentID ?? list.agents.first(where: \.isDefaultAgent)?.agentId
    newComposer.requestSync()
    newModelSelection.resetNewChat()
    error = nil
  }

  @discardableResult
  func createChat(agentID: String? = nil) async -> ChatThread? {
    guard !isCreating, !needsUpgrade, !closed, !Task.isCancelled else { return nil }
    guard newModelSelection.canSend else { return nil }
    let selection = modelStore.configuration.map { _ in
      newModelSelection.captureNewChatSelection()
    }
    let effort = newModelSelection.requestedEffort
    newModelSelection.isSending = true
    isCreating = true
    let task = Task<ChatThread?, Never> { [weak self] in
      guard let self else { return nil }
      defer {
        isCreating = false
        newModelSelection.isSending = false
        creationTask = nil
      }
      do {
        let thread = try await commands.createThread(
          agentID: agentID, modelSelection: selection, reasoningEffort: effort)
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
    let wasAwaitingAgent = selectedAgentID == nil
    guard sourceComposer.hasContent, sourceComposer.canSend, newAttachmentDraft.isReady,
      selectedThreadID == nil, !isCreating, !needsUpgrade, !closed
    else {
      return
    }
    guard let created = await createChat(agentID: selectedAgentID), !closed,
      let conversation = conversation(for: created.id)
    else { return }
    sourceComposer.move(to: conversation.composer)
    if wasAwaitingAgent && newComposer !== sourceComposer {
      newComposer.clear()
      newComposer.requestSync()
    }
    sourceComposer.requestSync()
    await conversation.send(initialSelection: ChatModelSelection(thread: created))
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
      guard selectedThreadID != id, chatLinkThreadID != id,
        let conversation = conversations[id], conversation.canRelease
      else { continue }
      guard await sync.releaseHistory(threadID: id), !closed, selectedThreadID != id,
        chatLinkThreadID != id,
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
