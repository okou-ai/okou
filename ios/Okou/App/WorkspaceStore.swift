import CCState
import ChatData
import ChatDomain
import Foundation
import OSLog
import Observation
import SwiftUI

/// One immutable network/cache scope, with independently observed feature state.
@MainActor @Observable
final class WorkspaceStore {
  private let lifecycleTasks: LifecycleTasks
  private let client: APIClient
  private let sync: ChatSync
  private let projectDisclosure: ProjectDisclosureStorage?
  private let resources: WorkspaceResources
  private let modelBootstrap: WorkspaceModelBootstrap?
  private let createRealtime: RealtimeService.ClientFactory?
  private let commands: ChatCommands
  private let conversationLimit: Int
  private let readRetrySleep: @Sendable (Duration) async throws -> Void
  private let historyWarmingSleep: @Sendable (Duration) async throws -> Void
  private let didRefreshReadState: @MainActor () -> Void
  let webURL: URL
  let messageMarkdown: MessageMarkdownCache
  var settingsResources: WorkspaceResources { resources }
  var billingURL: URL { webURL.appending(path: "settings/billing") }
  private(set) var needsUpgrade = false
  private(set) var isCreating = false
  private(set) var newChatSubmission: NewChatSubmission?
  var error: String?
  private(set) var chatLinkError: String?
  private(set) var threadFeedback: ChatThreadFeedback?
  private(set) var threadPreview: ChatThreadPreviewResources?
  let sidebarInteraction = SidebarInteraction()
  private var chatLinkRequestID = UUID()
  @ObservationIgnored private var chatLinkThreadID: String?
  @ObservationIgnored private let selectedThread = CCState.State<String?>(nil)
  @ObservationIgnored private let selectThread: Command<Void, String?>
  var selectedThreadID: String? {
    get {
      access(keyPath: \.selectedThreadID)
      do { return try resources.store.get(selectedThread) } catch {
        preconditionFailure("Cannot read workspace selection: \(error)")
      }
    }
    set {
      let previous = selectedConversation
      withMutation(keyPath: \.selectedThreadID) {
        do { try resources.store.set(selectThread, newValue) } catch {
          preconditionFailure("Cannot update workspace selection: \(error)")
        }
      }
      selectedConversation = newValue.flatMap { conversation(for: $0) }
      previous?.reconcileVisibility()
      selectedConversation?.reconcileVisibility()
    }
  }
  var selectedAgentID: String? { selectedConversation?.thread.agentID ?? defaultAgentID }
  var defaultAgentID: String? { list.agents.first(where: \.isDefaultAgent)?.agentId }
  private(set) var newChatProjectID: String?
  var newChatProject: ChatProject? {
    projects.projects.first { $0.id == newChatProjectID }
  }
  var newChatDraft: String {
    get { newComposer.text }
    set { newComposer.text = newValue }
  }
  var newAttachmentDraft: AttachmentDraftStore { newComposer.attachments }
  private(set) var newComposer: ComposerDraftStore
  private let draftStorage: ChatDraftStorage?
  private let voiceCapture: (@MainActor () -> any VoiceAudioCapture)?
  private let measurementScope: ChatCacheScope?
  private let draftRepository: ChatDraftRepository?
  private var draftAgentID: String?
  private var agentDraftTask: Task<Void, Never>?
  @ObservationIgnored private lazy var sidebarDrafts = SidebarDraftStore(
    resources: resources, lifecycleTasks: lifecycleTasks,
    didFail: { [weak self] in self?.handle($0) })
  private(set) var connectionStatus = RealtimeConnectionStatus.connecting

  var synchronizationState: ChatSynchronizationState? {
    guard !closed else { return nil }
    if selectedConversation?.isLoading == true { return .updating }
    if list.syncError != nil
      || selectedConversation?.syncError != nil
    {
      return .updateFailed
    }
    guard realtime != nil else { return nil }
    switch connectionStatus {
    case .connecting: return .connecting
    case .unavailable, .disconnected: return .liveUpdatesUnavailable
    case .connected: return nil
    }
  }

  func retrySynchronization() async {
    guard !closed, !needsUpgrade, !Task.isCancelled else { return }
    realtime?.retry()
    do { try resources.retrySidebarDrafts() } catch { handle(error) }
    async let drafts: Void = activateDrafts()
    await refreshNavigation()
    await refresh()
    await drafts
  }

  @ObservationIgnored lazy var modelStore = ChatModelStore(
    client: client, webURL: webURL, resources: resources, readRetrySleep: readRetrySleep,
    didFail: { [weak self] in self?.handle($0) })
  @ObservationIgnored lazy var composerWorkflows = ComposerWorkflowSource(
    client: client, storage: draftStorage, didFail: { [weak self] in self?.handle($0) })
  @ObservationIgnored lazy var newModelSelection = ChatModelSelectionStore(
    models: modelStore, lifecycleTasks: lifecycleTasks)
  @ObservationIgnored lazy var search = ChatSearchStore(
    sync: sync, didFail: { [weak self] in self?.handle($0) })
  /// Previews of results opened from workspace search, which belong to no chat.
  @ObservationIgnored lazy var searchArtifacts = MessageArtifactStore(
    service: commands.artifacts, threadID: nil, webURL: webURL, markdown: messageMarkdown,
    didFail: { [weak self] in self?.handle($0) })

  @ObservationIgnored lazy var list = ThreadListStore(
    client: client, sync: sync, commands: commands, resources: resources,
    didRefresh: { [weak self] in self?.applyThreads($0) },
    didFail: { [weak self] in self?.handle($0) },
    didLoadAgents: { [weak self] in self?.prepareDefaultDraft(from: $0) },
    readRetrySleep: readRetrySleep, lifecycleTasks: lifecycleTasks)
  @ObservationIgnored lazy var projects = ChatProjectStore(
    client: client, resources: resources, sync: sync, disclosure: projectDisclosure,
    didFail: { [weak self] in self?.handle($0) },
    didChangeMembership: { [weak self] in await self?.list.refresh(waitForCurrent: true) },
    lifecycleTasks: lifecycleTasks)
  @ObservationIgnored lazy var sidebar = ChatSidebarStore(
    store: resources.store, threads: list.threadsValue, agents: list.agentsValue,
    projects: projects.confirmedValue, selectedThread: selectedThread)
  @ObservationIgnored private var conversations: [String: ConversationStore] = [:]
  @ObservationIgnored private var lastUse: [String: UInt64] = [:]
  private var clock: UInt64 = 0
  private var realtime: RealtimeService?
  private var invalidations: Set<ChatInvalidation> = []
  private var refreshTask: Task<Void, Never>?
  private var refreshGeneration = UUID()
  private var refreshSuspended = false
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
    sharedSync: ChatSync? = nil, draftStorage: ChatDraftStorage? = nil,
    projectDisclosure: ProjectDisclosureStorage? = nil,
    measurementScope: ChatCacheScope? = nil,
    voiceCapture: (@MainActor () -> any VoiceAudioCapture)? = nil,
    readRetrySleep: @escaping @Sendable (Duration) async throws -> Void = {
      try await Task.sleep(for: $0)
    },
    historyWarmingSleep: @escaping @Sendable (Duration) async throws -> Void = {
      try await Task.sleep(for: $0)
    },
    modelBootstrap: WorkspaceModelBootstrap? = nil,
    createRealtime: RealtimeService.ClientFactory? = nil,
    didRefreshReadState: @escaping @MainActor () -> Void = {}
  ) {
    let lifecycleTasks = LifecycleTasks()
    self.lifecycleTasks = lifecycleTasks
    let selectedThread = selectedThread
    selectThread = Command { context, value in
      guard try context.get(selectedThread) != value else { return }
      try context.set(selectedThread, value)
    }
    self.client = client
    let sync = sharedSync ?? ChatSync(client: client, cache: cache)
    self.sync = sync
    self.modelBootstrap = modelBootstrap
    self.createRealtime = createRealtime
    resources = WorkspaceResources(
      client: client, sync: sync, sleep: readRetrySleep, modelBootstrap: modelBootstrap,
      lifecycleTasks: lifecycleTasks)
    self.readRetrySleep = readRetrySleep
    self.historyWarmingSleep = historyWarmingSleep
    self.didRefreshReadState = didRefreshReadState
    self.draftStorage = draftStorage
    self.projectDisclosure = projectDisclosure
    self.measurementScope = measurementScope
    self.voiceCapture = voiceCapture
    draftRepository = draftStorage.map { _ in ChatDraftRepository(client: client) }
    let commands = ChatCommands(client: client, sync: sync)
    self.commands = commands
    self.webURL = webURL
    self.messageMarkdown = MessageMarkdownCache(baseURL: webURL)
    self.conversationLimit = max(0, conversationLimit)
    newComposer = ComposerDraftStore(
      target: .unassigned, commands: commands, storage: draftStorage,
      didFail: { _ in }, lifecycleTasks: lifecycleTasks)
    newComposer.setForeground(isForeground)
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
        list.cancelNavigationPublication()
      }
    }
    await list.restoreCached()
    await projects.restore()
    guard canContinueStartup(generation) else { return }
    prepareDefaultDraft(from: list.agents)
    await withTaskCancellationHandler {
      async let navigation: Void = refreshNavigation()
      let realtime = RealtimeService(
        userID: userID, workspaceID: workspaceID,
        tokenProvider: { [client] in
          try await client.data("/api/realtime/token", method: "POST", body: Data("{}".utf8)).data
        },
        onChange: { [weak self] in self?.requestRefresh($0) },
        onConnection: { [weak self] status in
          self?.connectionStatus = status
          self?.modelBootstrap?.connectionChanged(status)
        },
        createRealtime: createRealtime, lifecycleTasks: lifecycleTasks)
      self.realtime = realtime
      realtime.setForeground(isForeground)
      realtime.start()
      await refresh([.startup])
      await navigation
    } onCancel: {
      Task { @MainActor [weak self] in
        guard let self, startupGeneration == generation else { return }
        realtime?.stop()
        realtime = nil
        list.cancelRefresh()
        list.cancelNavigationPublication()
      }
    }
  }

  private func canContinueStartup(_ generation: UUID) -> Bool {
    !closed && !needsUpgrade && !Task.isCancelled && startupGeneration == generation
  }

  func refreshNavigation() async {
    await list.refreshNavigation()
  }

  private func prepareDefaultDraft(from agents: [AgentRecord]) {
    guard !closed, !needsUpgrade, !Task.isCancelled else { return }
    let id = agents.first(where: \.isDefaultAgent)?.agentId
    if let id { activateDefaultDraft(agentID: id) }
  }

  var currentAgentName: String {
    list.agents.first(where: { $0.agentId == selectedAgentID })?.displayName ?? "Okou"
  }

  private(set) var selectedConversation: ConversationStore?

  /// Whether a chat holds text or files the user has not sent. A chat still in memory answers
  /// from its own composer, so leaving a chat marks it at once; others use the API's list.
  func hasDraft(_ threadID: String) -> Bool {
    // A row tracks the selected owner before consulting the non-observable resident cache.
    if let conversation = selectedConversation, conversation.thread.id == threadID {
      return conversation.composer.hasContent
    }
    if let composer = conversations[threadID]?.composer { return composer.hasContent }
    return sidebarDrafts.threadIDs.contains(threadID)
  }

  func conversation(for id: String) -> ConversationStore? {
    guard !closed, let thread = list.threads.first(where: { $0.id == id }) else { return nil }
    clock &+= 1
    lastUse[id] = clock
    if let conversation = conversations[id] { return conversation }
    let conversation = ConversationStore(
      thread: thread, sync: sync, commands: commands, webURL: webURL,
      messageMarkdown: messageMarkdown,
      isVisible: { [weak self] in
        self?.isForeground == true && self?.selectedThreadID == id
          && self?.sidebarInteraction.isOpen == false
      },
      didMarkRead: { [weak self] watermark in self?.list.markRead(id, through: watermark) },
      didSend: { [weak self] in self?.requestRefresh(.threadList) },
      didFail: { [weak self] in self?.handle($0) },
      didSettle: { [weak self] in self?.requestPrune() },
      modelSelection: ChatModelSelectionStore(
        models: modelStore, thread: thread, lifecycleTasks: lifecycleTasks),
      workflowSource: composerWorkflows,
      draftRepository: draftRepository, draftStorage: draftStorage,
      didSaveDraft: { [weak self] draft in await self?.sidebarDrafts.didSave(draft, threadID: id) },
      measurementScope: measurementScope,
      didRequestNewChat: { [weak self] in self?.startNewChat() },
      readRetrySleep: readRetrySleep, lifecycleTasks: lifecycleTasks)
    conversation.composer.setForeground(isForeground)
    conversation.runOutput = { [weak self] runID, handler in
      self?.realtime?.subscribeRunOutput(runID: runID, handler: handler)
    }
    conversations[id] = conversation
    return conversation
  }

  func previewChat(_ id: String) {
    guard !closed, !needsUpgrade, threadPreview?.threadID != id,
      list.threads.contains(where: { $0.id == id })
    else { return }
    threadPreview?.close()
    // Share serialized history reads without retaining a conversation, draft or realtime work.
    threadPreview = ChatThreadPreviewResources(
      threadID: id, sync: sync,
      didFinish: { [weak self, sync] in
        guard self?.conversations[id] == nil else { return }
        _ = await sync.releaseHistory(threadID: id)
      },
      didFail: { [weak self] in self?.handle($0) })
  }

  func dismissChatPreview(_ id: String) {
    guard threadPreview?.threadID == id else { return }
    threadPreview?.close()
    threadPreview = nil
  }

  @discardableResult
  func close() -> Task<Void, Never> {
    sidebarDrafts.close()
    threadPreview?.close()
    threadPreview = nil
    closed = true
    sidebar.close()
    startupGeneration = UUID()
    refreshTask?.cancel()
    creationTask?.cancel()
    newChatSubmission?.close()
    newChatSubmission = nil
    pruneTask?.cancel()
    warmingTask?.cancel()
    modelStore.close()
    composerWorkflows.close()
    newModelSelection.close()
    list.close()
    projects.close()
    resources.close()
    threadFeedback = nil
    search.close()
    searchArtifacts.close()
    for conversation in conversations.values { conversation.close() }
    realtime?.stop()
    realtime = nil
    messageMarkdown.clear()
    agentDraftTask?.cancel()
    newComposer.close()
    commands.closeFileCache()
    let work = lifecycleTasks.close()
    let disclosure = projectDisclosure
    return Task {
      await work.value
      await disclosure?.close().value
    }
  }

  func setPhase(_ phase: ScenePhase) {
    guard !closed else { return }
    let active = phase == .active
    // Background suspension survives the intermediate inactive phase on the way back.
    let resuming = refreshSuspended
    guard isForeground != active || (phase == .background && !refreshSuspended) else { return }
    isForeground = active
    realtime?.setForeground(active)
    if phase == .background {
      modelBootstrap?.beginRecovery()
      refreshSuspended = true
      refreshGeneration = UUID()
      refreshTask?.cancel()
      refreshTask = nil
      warmingTask?.cancel()
      warmingTask = nil
      list.cancelRefresh()
      for conversation in conversations.values { conversation.cancelRefresh() }
      // Reconnect with a complete catch-up, including invalidations received while suspended.
      invalidations.insert(.foregroundResume)
    } else if active {
      refreshSuspended = false
      if resuming, connectionStatus == .connected {
        _ = modelBootstrap?.subscriptionsReady()
      }
    }
    newComposer.setForeground(active)
    for conversation in conversations.values { conversation.composer.setForeground(active) }
    selectedConversation?.reconcileVisibility()
    if active && resuming {
      (selectedConversation?.composer ?? newComposer).requestSync()
    }
  }

  private func activateDefaultDraft(agentID: String) {
    guard !closed, draftAgentID != agentID else { return }
    agentDraftTask?.cancel()
    let previous = newComposer
    let composer = ComposerDraftStore(
      target: .agent(agentID), commands: commands,
      repository: draftRepository, storage: draftStorage,
      didFail: { [weak self] in self?.handle($0) }, voiceCapture: voiceCapture?(),
      syncSleep: readRetrySleep, lifecycleTasks: lifecycleTasks)
    // Preserve input entered before navigation resolves the default Agent.
    if !isCreating && previous.hasContent && draftAgentID == nil {
      previous.move(to: composer)
    }
    if !isCreating { previous.close() }
    draftAgentID = agentID
    newComposer = composer
    composer.setForeground(isForeground)
    agentDraftTask = Task { await composer.synchronize() }
    if let agentDraftTask { lifecycleTasks.track(agentDraftTask) }
  }

  func requestRefresh(_ invalidation: ChatInvalidation = .reconnected) {
    guard !closed, !needsUpgrade else { return }
    if invalidation == .realtimeResume || invalidation == .realtimeGap {
      modelBootstrap?.beginRecovery()
    }
    invalidations.insert(invalidation)
    resumePendingRefresh()
  }

  @discardableResult
  func resumePendingRefresh() -> Task<Void, Never>? {
    guard !closed, !needsUpgrade, !refreshSuspended else { return nil }
    if let refreshTask { return refreshTask }
    guard !invalidations.isEmpty else { return nil }
    let generation = refreshGeneration
    refreshTask = Task { [weak self] in
      guard let self else { return }
      defer {
        if refreshGeneration == generation { refreshTask = nil }
      }
      while !invalidations.isEmpty && !closed && !needsUpgrade && !Task.isCancelled
        && refreshGeneration == generation
      {
        let batch = invalidations
        invalidations.removeAll()
        await refresh(batch)
      }
    }
    if let refreshTask { lifecycleTasks.track(refreshTask) }
    return refreshTask
  }

  /// Awaitable refresh boundary used by manual refresh and deterministic HTTP tests.
  func refresh(_ batch: Set<ChatInvalidation> = [.reconnected]) async {
    guard !closed, !needsUpgrade, !refreshSuspended, !Task.isCancelled else { return }
    let generation = refreshGeneration
    let full = batch.contains(where: \.requiresFullRefresh)
    let selectedBeforeRefresh = selectedThreadID
    let awaitingSelectedThread = selectedThreadID != nil && selectedConversation == nil
    async let historyRefresh: Void = refreshConversations(batch, generation: generation)
    // Model catch-up must stay fresh, but it does not gate the chat list or messages.
    async let accessRefresh: Void = refreshComputerAuthorizations(batch)
    async let modelRefresh: Void = refreshModels(batch)
    async let projectRefresh: Void = refreshProjects(batch)
    async let indicatorsRefresh: Void = refreshIndicators(batch)
    guard refreshGeneration == generation, !Task.isCancelled else { return }
    if full || batch.contains(.threadList) {
      await list.refresh(includingIndicators: false)
    }
    guard !closed, !needsUpgrade, !Task.isCancelled, refreshGeneration == generation else { return }
    await historyRefresh
    if awaitingSelectedThread, selectedThreadID == selectedBeforeRefresh {
      await selectedConversation?.refresh()
    }
    await accessRefresh
    await modelRefresh
    await projectRefresh
    await indicatorsRefresh
    guard !closed, !needsUpgrade, !Task.isCancelled, refreshGeneration == generation else { return }
    if modelStore.configuration != nil,
      full || selectedConversation?.modelSelection?.needsThreadReadback == true
    {
      await selectedConversation?.modelSelection?.refresh()
    }
    await trimConversations(limit: conversationLimit)
    requestHistoryWarming()
  }

  private func refreshComputerAuthorizations(_ batch: Set<ChatInvalidation>) async {
    guard let conversation = selectedConversation else { return }
    if batch.contains(.computerAccess) || batch.contains(where: \.requiresFullRefresh)
      || batch.contains(.detail(threadID: conversation.thread.id))
      || batch.contains(.history(threadID: conversation.thread.id))
    {
      await conversation.approvals.refreshComputers()
    }
  }

  private func refreshModels(_ batch: Set<ChatInvalidation>) async {
    let full = batch.contains(where: \.requiresFullRefresh)
    if modelStore.active
      && (full || batch.contains(.runModels) || batch.contains(.modelPreference)
        || batch.contains(.realtimeResume))
    {
      await modelStore.refresh(batch)
    } else if full || batch.contains(.realtimeResume) {
      do { try resources.invalidate(batch) } catch { handle(error) }
    }
  }

  private func refreshIndicators(_ batch: Set<ChatInvalidation>) async {
    if batch.contains(where: \.requiresFullRefresh) || batch.contains(.indicators)
      || batch.contains(.readCursor)
    {
      await list.refreshIndicators()
    }
  }

  private func refreshProjects(_ batch: Set<ChatInvalidation>) async {
    if projects.active
      && (batch.contains(where: \.requiresFullRefresh) || batch.contains(.threadList))
    {
      await projects.refresh()
    }
  }

  private func refreshConversations(_ batch: Set<ChatInvalidation>, generation: UUID) async {
    var ids = Set<String>()
    for invalidation in batch {
      switch invalidation {
      case .history(let id), .detail(let id): ids.insert(id)
      default: break
      }
    }
    if batch.contains(where: \.requiresFullRefresh) || batch.contains(.readCursor),
      let selectedThreadID
    {
      ids.insert(selectedThreadID)
    }
    let ordered = ids.sorted { lhs, rhs in
      if lhs == rhs { return false }
      if lhs == selectedThreadID { return true }
      if rhs == selectedThreadID { return false }
      return lhs < rhs
    }
    for id in ordered {
      guard !Task.isCancelled, refreshGeneration == generation else { return }
      // Dormant conversations read their durable state when opened.
      if let conversation = conversations[id] {
        await conversation.refresh()
      } else if selectedThreadID == id {
        await conversation(for: id)?.refresh()
      }
    }
  }

  private func requestHistoryWarming() {
    guard !closed, !needsUpgrade, !refreshSuspended else { return }
    warmAgain = true
    guard warmingTask == nil else { return }
    let generation = refreshGeneration
    warmingTask = Task(priority: .utility) { [weak self] in
      guard let self else { return }
      defer {
        if refreshGeneration == generation { warmingTask = nil }
      }
      repeat {
        // Coalesce startup, indicator updates and bursts of realtime messages.
        do { try await historyWarmingSleep(.seconds(1)) } catch { return }
        guard !closed, !needsUpgrade, !refreshSuspended, !Task.isCancelled,
          refreshGeneration == generation
        else { return }
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
    if let warmingTask { lifecycleTasks.track(warmingTask) }
  }

  func selectChat(_ id: String) {
    guard !closed, let thread = list.threads.first(where: { $0.id == id }) else { return }
    chatLinkRequestID = UUID()
    chatLinkThreadID = nil
    presentChat(thread)
  }

  private func presentChat(_ thread: ChatThread) {
    let id = thread.id
    let reselected = selectedThreadID == id
    if !reselected, newChatSubmission?.isReadyForConversation == true {
      newChatSubmission?.close()
      newChatSubmission = nil
    }
    selectedThreadID = id
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
      await list.restoreCached()
      guard ownsRequest() else { return false }
      if !list.threads.contains(where: { $0.id == id }) {
        let refreshed = await list.refresh(waitForCurrent: true)
        guard ownsRequest(), refreshed, list.error == nil else { return false }
      }
      guard ownsRequest() else { return false }
      // Keep the destination resident while its history resolves the run anchor.
      chatLinkThreadID = id
      guard let conversation = conversation(for: id) else {
        chatLinkError = "This chat is no longer available in this workspace."
        return false
      }
      presentChat(conversation.thread)
      await conversation.restoreCached()
      guard ownsRequest() else { return false }
      if let runID {
        if !conversation.revealRun(runID) {
          await conversation.refresh(waitForCurrent: true)
          guard ownsRequest() else { return false }
          _ = conversation.revealRun(runID)
        }
      }
      guard ownsRequest() else { return false }
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
    if needsRefresh {
      guard await list.refresh(waitForCurrent: true) else { return false }
    }
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
  func moveToProject(
    _ id: String, projectID: String?, didBegin: @MainActor () -> Void = {}
  ) async -> Bool {
    guard !closed, !needsUpgrade else { return false }
    return await list.setProject(
      id, projectID: projectID,
      onFailure: { [weak self] message in
        guard let self, !closed, !needsUpgrade else { return }
        threadFeedback = ChatThreadFeedback(
          threadID: id, message: message, actionTitle: "Retry", persists: true, kind: .error
        ) { [weak self] in
          await self?.moveToProject(id, projectID: projectID)
        }
      },
      didBegin: {
        if threadFeedback?.threadID == id { threadFeedback = nil }
        if let projectID { projects.expand(projectID) }
        didBegin()
      })
  }

  @discardableResult
  func setArchived(
    _ id: String, archived: Bool, leaveDetail: Bool = false,
    restoreOnUndo: Bool = false, reopenOnSuccess: Bool = false,
    eventID: String = UUID().uuidString.lowercased()
  ) async -> Bool {
    guard !closed, !needsUpgrade, list.canUpdate(id),
      let thread = list.threads.first(where: { $0.id == id })
    else { return false }
    let leaving = archived && leaveDetail && selectedThreadID == id
    // Creation already owns the next navigation when its response arrives.
    guard !isCreating || (!leaving && !reopenOnSuccess) else { return false }
    let restore = leaving || restoreOnUndo
    var failure: String?
    var pendingFeedbackID: UUID?
    let succeeded = await list.setArchived(
      thread, archived: archived, eventID: eventID, onFailure: { failure = $0 },
      didBegin: {
        // The list owns the write, so leaving the detail cannot cancel it.
        if leaving { self.sidebarInteraction.setOpen(true) }
        let pending = ChatThreadFeedback(
          threadID: id,
          message: archived
            ? String(localized: "Archiving chat…") : String(localized: "Unarchiving chat…"),
          actionTitle: nil, persists: true, isWorking: true
        ) {}
        pendingFeedbackID = pending.id
        self.threadFeedback = pending
      })
    guard !closed, !needsUpgrade else { return false }
    // A late acknowledgement must not replace feedback from a newer action or dismissal.
    guard let pendingFeedbackID, threadFeedback?.id == pendingFeedbackID else { return succeeded }
    if succeeded {
      if reopenOnSuccess {
        selectChat(id)
        sidebarInteraction.setOpen(false)
      }
      let message =
        archived
        ? (thread.isMuted
          ? "Chat archived. It will stay archived while muted."
          : "Chat archived. A new reply will bring it back.")
        : "Chat unarchived."
      threadFeedback = ChatThreadFeedback(
        threadID: id, message: message,
        actionTitle: restore ? String(localized: "Undo and return to chat") : "Undo",
        requiresNavigation: restore
      ) {
        [weak self] in
        guard let self else { return }
        await self.setArchived(id, archived: !archived, reopenOnSuccess: restore)
      }
    } else {
      threadFeedback = ChatThreadFeedback(
        threadID: id, message: failure ?? "The archive change was not confirmed.",
        actionTitle: "Retry", persists: true, requiresNavigation: reopenOnSuccess, kind: .error
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
    var failure: String?
    let succeeded = await list.setMuted(
      id, muted: muted, markRead: markRead, onFailure: { failure = $0 })
    guard !closed, !needsUpgrade else { return }
    if succeeded {
      let message =
        muted
        ? "Chat muted"
        : "Chat unmuted"
      threadFeedback = ChatThreadFeedback(
        threadID: id, message: message, actionTitle: "Undo"
      ) { [weak self] in
        // Undo restores mute state without clearing unread replies, like the PWA.
        await self?.setMuted(id, muted: !muted, markRead: false)
      }
    } else {
      threadFeedback = ChatThreadFeedback(
        threadID: id, message: failure ?? "The mute change was not confirmed.",
        actionTitle: "Retry", persists: true, kind: .error
      ) { [weak self] in
        await self?.setMuted(id, muted: muted, markRead: markRead)
      }
    }
  }

  /// Puts `/name` at the start of the new chat's draft, as choosing the workflow from the
  /// composer's `/` menu does; whatever the draft already held stays after it.
  func useWorkflow(named name: String) {
    let token = "/" + name + " "
    guard !newChatDraft.hasPrefix(token) else { return }
    newChatDraft = token + newChatDraft
  }

  func startNewChat(projectID: String? = nil) {
    guard !isCreating, !needsUpgrade, !closed else { return }
    newChatSubmission?.close()
    newChatSubmission = nil
    chatLinkRequestID = UUID()
    chatLinkThreadID = nil
    selectedThreadID = nil
    newChatProjectID = projectID
    newComposer.requestSync()
    newModelSelection.resetNewChat()
    error = nil
  }

  func removeNewChatProject() { newChatProjectID = nil }

  func deleteProject(_ id: String) async {
    if await projects.delete(id), !closed, newChatProjectID == id {
      removeNewChatProject()
    }
  }

  var canOpenNewChatFromSystem: Bool {
    isForeground && defaultAgentID != nil && !isCreating && !needsUpgrade && !closed
  }

  @discardableResult
  func openNewChatFromSystem(startVoiceInput: Bool = false) -> Bool {
    guard canOpenNewChatFromSystem else { return false }
    startNewChat()
    search.dismiss()
    if startVoiceInput {
      if let request = newComposer.focusRequest { newComposer.consumeFocusRequest(request) }
      newComposer.editor.dismissKeyboard()
      newComposer.voice?.requestStart()
    } else {
      newComposer.voice?.suspend()
      if let block = newComposer.editorBlocks.last {
        newComposer.requestEditorFocus(block.id)
      }
    }
    return true
  }

  @discardableResult
  func createChat(composerOptions: ChatComposerOptions? = nil) async
    -> ChatThread?
  {
    guard creationTask == nil, !needsUpgrade, !closed, !Task.isCancelled else { return nil }
    guard newModelSelection.canSend else { return nil }
    let selection = modelStore.configuration.map { _ in
      newModelSelection.captureNewChatSelection()
    }
    let effort = newModelSelection.requestedEffort
    let projectID = newChatProjectID
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
          modelSelection: selection, reasoningEffort: effort,
          composerOptions: composerOptions, projectID: projectID)
        try Task.checkCancellation()
        guard !closed else { return nil }
        list.insertCreated(thread)
        selectedThreadID = thread.id
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
    lifecycleTasks.track(task)
    creationTask = task
    return await task.value
  }

  func sendNewChat(
    sendTransition: ConversationSendTransition? = nil, reduceMotion: Bool = false
  ) async {
    let sourceComposer = newComposer
    defer {
      if sourceComposer !== newComposer {
        if !closed, sourceComposer.hasContent {
          sourceComposer.move(to: newComposer)
          newComposer.requestSync()
        }
        sourceComposer.close()
      }
    }
    let wasAwaitingAgent = selectedAgentID == nil
    guard sourceComposer.hasContent, sourceComposer.canSend, newAttachmentDraft.isReady,
      selectedThreadID == nil, !isCreating, !needsUpgrade, !closed, !Task.isCancelled,
      newModelSelection.canSend
    else {
      return
    }
    let sourceAgentID = defaultAgentID
    newModelSelection.connectors.configure(agentID: sourceAgentID)
    let options = newModelSelection.connectors.pendingOptions
    let messageID = UUID().uuidString.lowercased()
    let transition = sendTransition ?? ConversationSendTransition()
    if sendTransition != nil, !reduceMotion, sourceComposer.attachments.items.isEmpty,
      sourceComposer.document.parts.allSatisfy({ $0["type"]?.string == "text" }),
      sourceComposer.editor.view?.markedTextRange == nil
    {
      transition.beginFirstMessage(messageID: messageID, sourceView: sourceComposer.editor.view)
    }
    // Commit marked text and present the first message before the creation request suspends.
    sourceComposer.editor.dismissKeyboard()
    let submission = NewChatSubmission(
      message: ConversationStore.PendingMessage(
        id: messageID,
        text: sourceComposer.text.trimmingCharacters(in: .whitespacesAndNewlines),
        createdAt: .now, attachments: sourceComposer.attachments.uploaded,
        document: sourceComposer.value.draftUserMessage?.trimmingWhitespace()),
      composer: ComposerDraftStore(target: .unassigned, commands: commands, didFail: { _ in }),
      viewer: MessageAttachmentStore(
        commands: commands, didFail: { [weak self] in self?.handle($0) }),
      transition: transition)
    newChatSubmission = submission
    defer {
      if newChatSubmission?.message.id == submission.message.id { newChatSubmission = nil }
      submission.close()
    }
    guard let created = await createChat(composerOptions: options),
      !closed,
      let conversation = conversation(for: created.id)
    else { return }
    newModelSelection.connectors.consumeNewChatOptions(agentID: sourceAgentID ?? created.agentID)
    sourceComposer.move(to: conversation.composer)
    if wasAwaitingAgent && newComposer !== sourceComposer {
      newComposer.clear()
      newComposer.requestSync()
    }
    sourceComposer.requestSync()
    await conversation.send(
      initialMessage: submission.message,
      initialSelection: ChatModelSelection(thread: created),
      initialComputerAccess: options.computerAccess,
      willSend: { [weak self] id in
        guard let submission = self?.newChatSubmission, submission.message.id == id else { return }
        submission.isReadyForConversation = true
      })
    if sendTransition != nil { await submission.waitUntilPresented() }
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
    if let pruneTask { lifecycleTasks.track(pruneTask) }
  }

  private func applyThreads(_ threads: [ChatThread]) {
    guard !closed else { return }
    didRefreshReadState()
    for thread in threads { conversations[thread.id]?.thread = thread }
    if let selectedThreadID {
      if threads.contains(where: { $0.id == selectedThreadID }) {
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
      sidebarDrafts.noteReleased(id, hasDraft: conversation.composer.hasContent)
      conversation.close()
      conversations[id] = nil
      lastUse[id] = nil
    }
  }

  /// Sidebar activation observes the cached draft resource without invalidating it.
  func activateDrafts() async {
    guard !closed, !needsUpgrade, !Task.isCancelled, draftRepository != nil else { return }
    await sidebarDrafts.activate()
  }

  private func handle(_ failure: Error) {
    guard !closed, (failure as? APIClientError)?.statusCode == 426 else { return }
    needsUpgrade = true
    close()
  }

  func prepareSettings() {
    guard !closed, !needsUpgrade else { return }
    do { try resources.prepareSettings() } catch { handle(error) }
  }

  func loadSettingsBilling() async {
    guard !closed, !needsUpgrade, !Task.isCancelled else { return }
    do { try await resources.loadSettingsBilling() } catch is CancellationError {
    } catch { handle(error) }
  }

  func refreshSettingsBilling() async {
    prepareSettings()
    await loadSettingsBilling()
  }

}
