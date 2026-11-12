import ChatData
import Foundation
import Observation
import SwiftUI

/// The root subscription owns orchestration; a temporary child disappearance does not.
@MainActor @Observable
final class AppLifecycle {
  let authentication: AuthenticationService
  let configuration: AppConfiguration
  let notifications: NotificationService
  private let session: URLSession
  private(set) var workspace: WorkspaceLifecycle?
  private(set) var presentedScopeID: String?
  private var phase = ScenePhase.inactive
  private var closed = false
  private var rootGeneration = UUID()
  private var hasScope = false
  private var scopeID: String?
  private var presentationTask: Task<Void, Never>?
  private var scopeTask: Task<Void, Never>?
  private var notificationTask: Task<Void, Never>?
  private var foregroundTask: Task<Void, Never>?

  struct NotificationIdentity: Hashable {
    let scopeID: String?
    let userID: String?
    let isLoading: Bool
    let destination: NotificationDestination?
  }

  var notificationIdentity: NotificationIdentity {
    NotificationIdentity(
      scopeID: authentication.presentationScopeID, userID: authentication.userID,
      isLoading: authentication.isLoading, destination: notifications.pendingDestination)
  }

  init(
    authentication: AuthenticationService, configuration: AppConfiguration,
    session: URLSession = .shared, notifications: NotificationService
  ) {
    self.authentication = authentication
    self.configuration = configuration
    self.session = session
    self.notifications = notifications
    if let data = notifications.data(
      authentication: authentication, configuration: configuration, session: session)
    {
      workspace = WorkspaceLifecycle(
        data: data, configuration: configuration,
        authentication: authentication, notifications: notifications)
    }
  }

  func run() async {
    closed = false
    let generation = UUID()
    rootGeneration = generation
    _ = beginScopeUpdate()
    defer { if rootGeneration == generation { close() } }
    await withTaskCancellationHandler {
      await authentication.start()
    } onCancel: {
      Task { @MainActor [weak self] in
        guard let self, rootGeneration == generation else { return }
        close()
      }
    }
  }

  func updateScope() async {
    await beginScopeUpdate()?.value
  }

  private func beginScopeUpdate() -> Task<Void, Never>? {
    guard !closed else { return nil }
    let scopeID = authentication.presentationScopeID
    if hasScope, self.scopeID == scopeID { return scopeTask }
    hasScope = true
    self.scopeID = scopeID
    presentationTask?.cancel()
    scopeTask?.cancel()
    foregroundTask?.cancel()
    foregroundTask = nil
    let data = notifications.data(
      authentication: authentication, configuration: configuration, session: session)
    if workspace?.data.scopeID != data?.scopeID {
      workspace?.close()
      workspace = data.map {
        WorkspaceLifecycle(
          data: $0, configuration: configuration,
          authentication: authentication, notifications: notifications)
      }
    }
    workspace?.setForeground(phase == .active)
    if phase == .active { presentedScopeID = scopeID }
    presentationTask = Task { await authentication.preparePresentation() }
    let task = Task {
      await notifications.update(workspace: data)
      guard ownsScope(scopeID), !Task.isCancelled else { return }
      if !authentication.isLoading {
        await notifications.refreshNotificationState(userID: authentication.userID)
      }
      guard ownsScope(scopeID), !Task.isCancelled else { return }
      if phase == .active { await notifications.flushPrefetchReports() }
    }
    scopeTask = task
    return task
  }

  func updateNotificationDemand() async {
    guard !closed else { return }
    notificationTask?.cancel()
    let identity = notificationIdentity
    let task = Task {
      guard !closed, notificationIdentity == identity, !Task.isCancelled else { return }
      notifications.preparePending(authentication: authentication)
      if !authentication.isLoading {
        await notifications.refreshNotificationState(userID: authentication.userID)
      }
    }
    notificationTask = task
    await task.value
  }

  func setPhase(_ phase: ScenePhase) {
    guard !closed, self.phase != phase else { return }
    self.phase = phase
    notifications.setForeground(phase == .active)
    workspace?.setForeground(phase == .active)
    if phase == .active { presentedScopeID = authentication.presentationScopeID }
    foregroundTask?.cancel()
    foregroundTask = nil
    guard phase == .active else { return }
    let scopeID = authentication.presentationScopeID
    foregroundTask = Task {
      await authentication.refresh()
      guard ownsScope(scopeID), !Task.isCancelled, self.phase == .active else { return }
      await notifications.refreshRegistration()
      guard ownsScope(scopeID), !Task.isCancelled, self.phase == .active else { return }
      if !authentication.isLoading {
        await notifications.refreshNotificationState(userID: authentication.userID)
      }
      guard ownsScope(scopeID), !Task.isCancelled, self.phase == .active else { return }
      await notifications.flushPrefetchReports()
    }
  }

  func reduceMemory() async {
    await workspace?.reduceMemory()
  }

  private func ownsScope(_ scopeID: String?) -> Bool {
    !closed && authentication.presentationScopeID == scopeID
  }

  func close() {
    closed = true
    rootGeneration = UUID()
    hasScope = false
    presentationTask?.cancel()
    presentationTask = nil
    scopeTask?.cancel()
    scopeTask = nil
    notificationTask?.cancel()
    notificationTask = nil
    foregroundTask?.cancel()
    foregroundTask = nil
    workspace?.close()
    workspace = nil
    presentedScopeID = nil
  }
}

/// One immutable workspace owns startup and native lifecycle work until scope retirement.
@MainActor
final class WorkspaceLifecycle {
  let data: NotificationWorkspace
  let store: WorkspaceStore
  private let authentication: AuthenticationService
  private let notifications: NotificationService
  private var foreground = false
  private var closed = false
  private var startupTask: Task<Void, Never>?
  private var navigation: (id: UUID, destination: NotificationDestination, task: Task<Bool, Never>)?
  private var memoryTask: Task<Void, Never>?

  init(
    data: NotificationWorkspace, configuration: AppConfiguration,
    authentication: AuthenticationService, notifications: NotificationService
  ) {
    self.data = data
    self.authentication = authentication
    self.notifications = notifications
    let cacheScope = ChatCacheScope(
      apiBaseURL: configuration.apiURL, userID: data.userID, workspaceID: data.workspaceID)
    store = WorkspaceStore(
      client: data.client, webURL: configuration.webURL, sharedSync: data.sync,
      draftStorage: ChatDraftStorage(scope: cacheScope),
      projectDisclosure: ProjectDisclosureStorage(scope: cacheScope),
      measurementScope: cacheScope,
      modelBootstrap: WorkspaceModelBootstrap(),
      didRefreshReadState: { notifications.requestNotificationStateRefresh() })
  }

  func start() async {
    guard !closed else { return }
    if startupTask == nil {
      let store = store
      notifications.didSynchronize = { [weak store] in
        store?.requestRefresh(.history(threadID: $0))
      }
      store.setForeground(foreground)
      startupTask = Task { await store.start(userID: data.userID, workspaceID: data.workspaceID) }
    }
    await startupTask?.value
  }

  func openPendingNotification() async -> Bool {
    guard !closed, authentication.presentationScopeID == data.scopeID,
      let destination = notifications.pendingDestination
    else { return false }
    if let navigation, navigation.destination == destination { return await navigation.task.value }
    navigation?.task.cancel()
    let id = UUID()
    let task = Task {
      defer { if navigation?.id == id { navigation = nil } }
      let opened = await notifications.openPending(authentication: authentication, store: store)
      guard !closed, !Task.isCancelled, authentication.presentationScopeID == data.scopeID
      else { return false }
      return opened
    }
    navigation = (id, destination, task)
    return await task.value
  }

  func setForeground(_ active: Bool) {
    guard !closed, foreground != active else { return }
    foreground = active
    store.setForeground(active)
    if active, startupTask != nil { store.requestRefresh() }
  }

  func reduceMemory() async {
    guard !closed else { return }
    if let memoryTask {
      await memoryTask.value
      return
    }
    let task = Task {
      defer { memoryTask = nil }
      await store.reduceMemory()
    }
    memoryTask = task
    await task.value
  }

  func close() {
    closed = true
    startupTask?.cancel()
    startupTask = nil
    navigation?.task.cancel()
    navigation = nil
    memoryTask?.cancel()
    memoryTask = nil
    store.close()
  }
}
