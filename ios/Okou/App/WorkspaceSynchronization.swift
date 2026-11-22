import ChatData
import ChatDomain
import Foundation
import Observation
import SwiftUI

/// Owns startup, foreground suspension and coalesced realtime invalidation reads.
@MainActor @Observable
final class WorkspaceSynchronization {
  private weak var workspace: WorkspaceStore?
  private let client: APIClient
  private let resources: WorkspaceResources
  private let list: ThreadListStore
  private let projects: ChatProjectStore
  private let modelStore: ChatModelStore
  private let conversations: WorkspaceConversations
  private let modelBootstrap: WorkspaceReadBootstrap?
  private let projectBootstrap: WorkspaceReadBootstrap?
  private let indicatorsBootstrap: WorkspaceReadBootstrap?
  private let createRealtime: RealtimeService.ClientFactory?
  private let lifecycleTasks: LifecycleTasks
  private let conversationLimit: Int
  private let didRestoreSidebar: @MainActor () -> Void
  private let notificationRevision: @MainActor () -> Int
  private let notificationChanged: @MainActor () -> Void
  private let didFail: @MainActor (Error) -> Void
  private var closed: Bool { workspace?.isClosed != false }
  private var needsUpgrade: Bool { workspace?.needsUpgrade != false }
  private var selectedThreadID: String? { workspace?.selectedThreadID }
  private var selectedConversation: ConversationStore? { workspace?.selectedConversation }

  init(
    workspace: WorkspaceStore, client: APIClient, resources: WorkspaceResources,
    list: ThreadListStore, projects: ChatProjectStore, modelStore: ChatModelStore,
    conversations: WorkspaceConversations,
    modelBootstrap: WorkspaceReadBootstrap?, projectBootstrap: WorkspaceReadBootstrap?,
    indicatorsBootstrap: WorkspaceReadBootstrap?, createRealtime: RealtimeService.ClientFactory?,
    lifecycleTasks: LifecycleTasks, conversationLimit: Int,
    didRestoreSidebar: @escaping @MainActor () -> Void,
    notificationRevision: @escaping @MainActor () -> Int,
    notificationChanged: @escaping @MainActor () -> Void,
    didFail: @escaping @MainActor (Error) -> Void
  ) {
    self.workspace = workspace
    self.client = client
    self.resources = resources
    self.list = list
    self.projects = projects
    self.modelStore = modelStore
    self.conversations = conversations
    self.modelBootstrap = modelBootstrap
    self.projectBootstrap = projectBootstrap
    self.indicatorsBootstrap = indicatorsBootstrap
    self.createRealtime = createRealtime
    self.lifecycleTasks = lifecycleTasks
    self.conversationLimit = conversationLimit
    self.didRestoreSidebar = didRestoreSidebar
    self.notificationRevision = notificationRevision
    self.notificationChanged = notificationChanged
    self.didFail = didFail
  }

  func cancelRefresh() {
    startupGeneration = UUID()
    refreshTask?.cancel()
  }

  func stopRealtime() {
    realtime?.stop()
    realtime = nil
  }

  private(set) var connectionStatus = RealtimeConnectionStatus.connecting
  private(set) var realtime: RealtimeService?
  private var invalidations: Set<ChatInvalidation> = []
  private var refreshTask: Task<Void, Never>?
  private(set) var refreshGeneration = UUID()
  private(set) var refreshSuspended = false
  private var startupHistoryWarmingRequested = false
  private(set) var isForeground = false
  private var startupGeneration = UUID()

  func start(userID: String, workspaceID: String) async {
    guard let workspace else { return }
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
    async let cachedList: Void = list.restoreCached()
    async let cachedProjects: Void = projects.restore()
    await cachedList
    await cachedProjects
    guard canContinueStartup(generation) else { return }
    await workspace.prepareWorkspaceComposer()
    guard canContinueStartup(generation) else { return }
    didRestoreSidebar()
    await withTaskCancellationHandler {
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
    } onCancel: {
      Task { @MainActor [weak self] in
        guard let self, startupGeneration == generation else { return }
        realtime?.stop()
        realtime = nil
        list.cancelRefresh()
      }
    }
  }

  private func canContinueStartup(_ generation: UUID) -> Bool {
    !closed && !needsUpgrade && !Task.isCancelled && startupGeneration == generation
  }

  func setPhase(_ phase: ScenePhase) {
    guard let workspace else { return }
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
    workspace.newComposer.setForeground(active)
    for conversation in conversations.values { conversation.composer.setForeground(active) }
    selectedConversation?.reconcileVisibility()
    if active && resuming {
      (selectedConversation?.composer ?? workspace.newComposer).requestSync()
    }
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
    refreshTask = Task { [weak self, weak workspace = workspace] in
      guard let self, let workspace else { return }
      defer { withExtendedLifetime(workspace) {} }
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
    let observedNotificationRevision = notificationRevision()
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
    if notificationRevision() == observedNotificationRevision,
      batch.contains(.indicators) || batch.contains(.readCursor)
        || batch.contains(.initialSubscriptions) || batch.contains(.realtimeGap)
        || batch.contains(.reconnected)
    {
      // These signals can affect receipts outside the sidebar or leave unreadAt unchanged.
      notificationChanged()
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
      do { try resources.invalidate(batch) } catch { didFail(error) }
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
          didFail(error)
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
        await workspace?.conversation(for: id)?.refresh(waitForCurrent: true)
      }
    }
  }
}
