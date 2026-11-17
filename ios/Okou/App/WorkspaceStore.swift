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
  var navigationActions: WorkspaceChatActions { navigation }
  var residentConversations: WorkspaceConversations { conversations }
  private let lifecycleTasks: LifecycleTasks
  @ObservationIgnored private lazy var conversations = WorkspaceConversations(
    sync: sync, limit: conversationLimit, lifecycleTasks: lifecycleTasks, markdown: messageMarkdown,
    sleep: historyWarmingSleep, threads: { [weak self] in self?.list.threads ?? [] },
    isProtected: { [weak self] in self?.selectedThreadID == $0 || self?.chatLinkThreadID == $0 },
    canWarm: { [weak self] in
      guard let self else { return false }
      return !closed && !needsUpgrade && !refreshSuspended
    }, generation: { [weak self] in self?.refreshGeneration },
    didRelease: { [weak self] in self?.sidebarDrafts.noteReleased($0, hasDraft: $1) },
    didFail: { [weak self] in self?.handle($0) })
  @ObservationIgnored private lazy var navigation = WorkspaceChatActions(
    workspace: self, client: client, sync: sync, commands: commands, lifecycleTasks: lifecycleTasks,
    didSelect: { [weak self] in self?.presentChat($0) },
    didFinishOpening: { [weak self] in self?.conversations.requestPrune() },
    isResident: { [weak self] in self?.conversations[$0] != nil },
    didFail: { [weak self] in self?.handle($0) })
  private let client: APIClient
  private let sync: ChatSync
  private let projectDisclosure: ProjectDisclosureStorage?
  private let resources: WorkspaceResources
  private let modelBootstrap: WorkspaceReadBootstrap?
  private let projectBootstrap: WorkspaceReadBootstrap?
  private let indicatorsBootstrap: WorkspaceReadBootstrap?
  private let createRealtime: RealtimeService.ClientFactory?
  private let commands: ChatCommands
  private let conversationLimit: Int
  private let readRetrySleep: @Sendable (Duration) async throws -> Void
  private let historyWarmingSleep: @Sendable (Duration) async throws -> Void
  private let didRefreshReadState: @MainActor () -> Void
  private var notificationReadState: [String: WorkspaceNotificationReadState]?
  private var notificationReadRevision = 0
  let webURL: URL
  let messageMarkdown: MessageMarkdownCache
  var settingsResources: WorkspaceResources { resources }
  private(set) var needsUpgrade = false
  private(set) var isCreating = false
  private(set) var newChatSubmission: NewChatSubmission?
  var error: String?
  let sidebarInteraction = SidebarInteraction()
  /// Mount the sidebar with its cached chats, Projects and disclosure restored together.
  private(set) var hasRestoredSidebar = false
  private var chatLinkThreadID: String? { navigation.openingThreadID }
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
  private(set) var newChatProjectID: String?
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
    didChangeReadState: { [weak self] in self?.notificationReadStateChanged() },
    didLoadAgents: { [weak self] in self?.prepareDefaultDraft(from: $0) },
    readRetrySleep: readRetrySleep, indicatorsBootstrap: indicatorsBootstrap,
    lifecycleTasks: lifecycleTasks)
  @ObservationIgnored lazy var projects = ChatProjectStore(
    client: client, resources: resources, sync: sync, disclosure: projectDisclosure,
    didFail: { [weak self] in self?.handle($0) },
    didChangeMembership: { [weak self] in await self?.list.refresh(waitForCurrent: true) },
    lifecycleTasks: lifecycleTasks)
  @ObservationIgnored lazy var sidebar = ChatSidebarStore(
    store: resources.store, threads: list.threadsValue, agents: list.agentsValue,
    projects: projects.confirmedValue, selectedThread: selectedThread)
  private var realtime: RealtimeService?
  private var invalidations: Set<ChatInvalidation> = []
  private var refreshTask: Task<Void, Never>?
  private var refreshGeneration = UUID()
  private var refreshSuspended = false
  private var creationTask: Task<ChatThread?, Never>?
  private var startupHistoryWarmingRequested = false
  private var closed = false
  var isClosed: Bool { closed }
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
    modelBootstrap: WorkspaceReadBootstrap? = nil,
    projectBootstrap: WorkspaceReadBootstrap? = nil,
    indicatorsBootstrap: WorkspaceReadBootstrap? = nil,
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
    self.projectBootstrap = projectBootstrap
    self.indicatorsBootstrap = indicatorsBootstrap
    self.createRealtime = createRealtime
    resources = WorkspaceResources(
      client: client, sync: sync, sleep: readRetrySleep, modelBootstrap: modelBootstrap,
      projectBootstrap: projectBootstrap,
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
    hasRestoredSidebar = true
    await withTaskCancellationHandler {
      async let navigation: Void = refreshNavigation()
      let realtime = RealtimeService(
        userID: userID, workspaceID: workspaceID,
        tokenProvider: { [client] in
          try await client.data("/api/realtime/token", method: "POST", body: Data("{}".utf8)).data
        },
        onChange: { [weak self] change in
          guard let self, !closed, !needsUpgrade else { return }
          // Manual history refreshes share this invalidation but must not start a global warm.
          if case .history = change { conversations.noteHistoryChange() }
          requestRefresh(change)
        },
        onConnection: { [weak self] status in
          self?.connectionStatus = status
          self?.modelBootstrap?.connectionChanged(status)
          self?.projectBootstrap?.connectionChanged(status)
          self?.indicatorsBootstrap?.connectionChanged(status)
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

  private func prepareDefaultDraft(from agents: [AgentRecord]) {
    guard !closed, !needsUpgrade, !Task.isCancelled else { return }
    let id = agents.first(where: \.isDefaultAgent)?.agentId
    if let id { activateDefaultDraft(agentID: id) }
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
    return conversations.retain(id) {
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
        didSettle: { [weak self] in self?.conversations.requestPrune() },
        modelSelection: ChatModelSelectionStore(
          models: modelStore, thread: thread, lifecycleTasks: lifecycleTasks),
        workflowSource: composerWorkflows,
        draftRepository: draftRepository, draftStorage: draftStorage,
        didSaveDraft: { [weak self] draft in await self?.sidebarDrafts.didSave(draft, threadID: id)
        },
        measurementScope: measurementScope,
        didRequestNewChat: { [weak self] in self?.startNewChat() },
        readRetrySleep: readRetrySleep, lifecycleTasks: lifecycleTasks)
      conversation.composer.setForeground(isForeground)
      conversation.runOutput = { [weak self] runID, handler in
        self?.realtime?.subscribeRunOutput(runID: runID, handler: handler)
      }
      return conversation
    }
  }

  @discardableResult
  func close() -> Task<Void, Never> {
    navigation.close()
    sidebarDrafts.close()
    closed = true
    sidebar.close()
    startupGeneration = UUID()
    refreshTask?.cancel()
    creationTask?.cancel()
    newChatSubmission?.close()
    newChatSubmission = nil
    conversations.close()
    modelStore.close()
    composerWorkflows.close()
    newModelSelection.close()
    list.close()
    indicatorsBootstrap?.close()
    projects.close()
    resources.close()
    search.close()
    searchArtifacts.close()
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
      projectBootstrap?.beginRecovery()
      refreshSuspended = true
      refreshGeneration = UUID()
      refreshTask?.cancel()
      refreshTask = nil
      conversations.suspendWarming()
      if list.cancelRefresh() { invalidations.insert(.threadList) }
      for conversation in conversations.values { conversation.cancelRefresh() }
      // Other resources revalidate on return; list reads retain only unfinished or new work.
      invalidations.insert(.foregroundResume)
    } else if active {
      refreshSuspended = false
      if resuming, connectionStatus == .connected {
        _ = modelBootstrap?.subscriptionsReady()
      }
      if resuming, realtime?.hasContinuousSubscription == true {
        projectBootstrap?.resumeContinuously()
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
    if invalidation == .realtimeGap {
      projectBootstrap?.requireRecoveryRead()
    } else if invalidation == .realtimeResume {
      projectBootstrap?.resumeContinuously()
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
    guard !closed, !needsUpgrade, !Task.isCancelled else { return }
    if refreshSuspended {
      invalidations.formUnion(batch.filter(\.refreshesThreadList))
      return
    }
    let generation = refreshGeneration
    let full = batch.contains(where: \.requiresFullRefresh)
    let notificationRevision = notificationReadRevision
    let selectedBeforeRefresh = selectedThreadID
    let awaitingSelectedThread = selectedThreadID != nil && selectedConversation == nil
    async let historyRefresh: Void = refreshConversations(batch, generation: generation)
    // Model catch-up must stay fresh, but it does not gate the chat list or messages.
    async let accessRefresh: Void = refreshComputerAuthorizations(batch)
    async let modelRefresh: Void = refreshModels(batch)
    async let projectRefresh: Void = refreshProjects(batch)
    async let indicatorsRefresh: Void = refreshIndicators(batch)
    guard refreshGeneration == generation, !Task.isCancelled else { return }
    if batch.contains(where: \.refreshesThreadList) {
      await list.refresh(includingIndicators: false)
    }
    guard !closed, !needsUpgrade, !Task.isCancelled, refreshGeneration == generation else { return }
    await historyRefresh
    if awaitingSelectedThread, selectedThreadID == selectedBeforeRefresh {
      await selectedConversation?.refresh(waitForCurrent: true)
    }
    await indicatorsRefresh
    guard !closed, !needsUpgrade, !Task.isCancelled, refreshGeneration == generation else { return }
    if full || batch.contains(.readCursor), selectedThreadID == selectedBeforeRefresh {
      // Either independent read can finish first. Confirm read state with both
      // published results, before waiting on unrelated workspace resources.
      await selectedConversation?.reconcileReadState()
    }
    guard !closed, !needsUpgrade, !Task.isCancelled, refreshGeneration == generation else { return }
    await accessRefresh
    await modelRefresh
    await projectRefresh
    guard !closed, !needsUpgrade, !Task.isCancelled, refreshGeneration == generation else { return }
    if modelStore.configuration != nil,
      full || selectedConversation?.modelSelection?.needsThreadReadback == true
    {
      await selectedConversation?.modelSelection?.refresh()
    }
    await conversations.trimConversations(limit: conversationLimit)
    if notificationReadRevision == notificationRevision,
      batch.contains(.indicators) || batch.contains(.readCursor)
        || batch.contains(.initialSubscriptions) || batch.contains(.realtimeGap)
        || batch.contains(.reconnected)
    {
      // These signals can affect receipts outside the sidebar or leave unreadAt unchanged.
      notificationReadStateChanged()
    }
    if batch.contains(.startup), !startupHistoryWarmingRequested {
      startupHistoryWarmingRequested = true
      conversations.noteHistoryChange()
    }
    if conversations.needsWarming { conversations.requestHistoryWarming() }
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
    let immediate =
      batch.contains(.indicators) || batch.contains(.readCursor)
      || batch.contains {
        $0.requiresFullRefresh && $0 != .startup && $0 != .initialSubscriptions
      }
    var catchUp = false
    if batch.contains(.initialSubscriptions) {
      catchUp = indicatorsBootstrap?.subscriptionsReady() ?? true
    }
    if immediate || catchUp || batch.contains(.startup) {
      await list.refreshIndicators(waitForSubscriptions: !immediate && !catchUp)
    }
  }

  private func refreshProjects(_ batch: Set<ChatInvalidation>) async {
    let generation = refreshGeneration
    let recovery =
      batch.contains(.foregroundResume) || batch.contains(.realtimeResume)
      || batch.contains(.realtimeGap)
    var reload = batch.contains(.threadList) || batch.contains(.reconnected)
    if batch.contains(.startup) {
      reload = (projectBootstrap?.beginStartup() ?? true) || reload
    }
    if batch.contains(.initialSubscriptions) {
      reload = (projectBootstrap?.subscriptionsReady() ?? true) || reload
    }
    guard projects.active else { return }
    if recovery {
      if let projectBootstrap {
        do { try await projectBootstrap.wait() } catch is CancellationError {
          return
        } catch {
          handle(error)
          return
        }
        guard !closed, !Task.isCancelled, refreshGeneration == generation else { return }
        reload = projectBootstrap.needsRecoveryRead || reload
      } else {
        reload = batch.contains(.foregroundResume) || batch.contains(.realtimeGap) || reload
      }
    }
    if reload {
      await projects.refresh()
    } else if recovery || batch.contains(.startup) || batch.contains(.initialSubscriptions) {
      await projects.activate()
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
        await conversation.refresh(waitForCurrent: true)
      } else if selectedThreadID == id {
        await conversation(for: id)?.refresh(waitForCurrent: true)
      }
    }
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

  func startNewChat(projectID: String? = nil) {
    guard !isCreating, !needsUpgrade, !closed else { return }
    newChatSubmission?.close()
    newChatSubmission = nil
    navigation.cancelOpening()
    selectedThreadID = nil
    newChatProjectID = projectID
    newComposer.requestSync()
    newModelSelection.resetNewChat()
    error = nil
  }

  func removeNewChatProject() { newChatProjectID = nil }

  var canOpenNewChatFromSystem: Bool {
    isForeground && defaultAgentID != nil && !isCreating && !needsUpgrade && !closed
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

  private func applyThreads(_ threads: [ChatThread]) {
    guard !closed else { return }
    let state = WorkspaceNotificationReadState.snapshot(threads)
    let changed = notificationReadState.map { $0 != state } ?? false
    notificationReadState = state
    if changed { notificationReadStateChanged() }
    for thread in threads { conversations[thread.id]?.thread = thread }
    if let selectedThreadID {
      if threads.contains(where: { $0.id == selectedThreadID }) {
        selectedConversation = conversation(for: selectedThreadID)
      } else {
        self.selectedThreadID = nil
      }
    }
  }

  private func notificationReadStateChanged() {
    notificationReadRevision += 1
    didRefreshReadState()
  }

  /// Sidebar activation observes the cached draft resource without invalidating it.
  func activateDrafts() async {
    guard !closed, !needsUpgrade, !Task.isCancelled, draftRepository != nil else { return }
    await sidebarDrafts.activate()
  }

  func reportWorkspaceFailure(_ failure: Error) { handle(failure) }

  private func handle(_ failure: Error) {
    guard !closed, (failure as? APIClientError)?.statusCode == 426 else { return }
    needsUpgrade = true
    close()
  }

}
