import ChatData
import Foundation
import OSLog
import Observation
import UIKit
import UserNotifications

struct NotificationDestination: Decodable, Hashable, Sendable {
  let version: Int
  let userId: String
  let workspaceId: String
  let threadId: String
  let runId: String
  let notificationId: String

  init?(userInfo: [AnyHashable: Any]) {
    guard let value = userInfo["okou"], JSONSerialization.isValidJSONObject(value),
      let data = try? JSONSerialization.data(withJSONObject: value),
      let destination = try? JSONDecoder().decode(Self.self, from: data),
      destination.version == 1, !destination.userId.isEmpty, !destination.workspaceId.isEmpty,
      UUID(uuidString: destination.threadId) != nil, UUID(uuidString: destination.runId) != nil,
      !destination.notificationId.isEmpty
    else { return nil }
    self = destination
  }
}

/// One immutable authenticated data scope, shared by UI and notification work.
struct NotificationWorkspace {
  let scopeID: String
  let userID: String
  let workspaceID: String
  let client: APIClient
  let sync: ChatSync
}

@MainActor
protocol NotificationSystem {
  func authorizationStatus() async -> UNAuthorizationStatus
  func requestAuthorization() async throws -> Bool
  func register()
  func openSettings() async
  func deliveredNotifications() async -> [DeliveredChatNotification]
  func removeDeliveredNotifications(identifiers: [String])
  func setBadgeCount(_ count: Int) async throws
  var environment: String? { get }
}

@MainActor
struct AppleNotificationSystem: NotificationSystem {
  func authorizationStatus() async -> UNAuthorizationStatus {
    await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
  }
  func requestAuthorization() async throws -> Bool {
    try await UNUserNotificationCenter.current().requestAuthorization(options: [
      .alert, .sound, .badge,
    ])
  }
  func register() { UIApplication.shared.registerForRemoteNotifications() }
  func deliveredNotifications() async -> [DeliveredChatNotification] {
    let delivered = await UNUserNotificationCenter.current().deliveredNotifications()
    return delivered.compactMap { notification in
      guard
        let destination = NotificationDestination(
          userInfo: notification.request.content.userInfo)
      else { return nil }
      return DeliveredChatNotification(
        identifier: notification.request.identifier, destination: destination)
    }
  }
  func removeDeliveredNotifications(identifiers: [String]) {
    UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: identifiers)
  }
  func setBadgeCount(_ count: Int) async throws {
    try await UNUserNotificationCenter.current().setBadgeCount(count)
  }
  func openSettings() async {
    if let url = URL(string: UIApplication.openSettingsURLString) {
      await UIApplication.shared.open(url)
    }
  }
  var environment: String? {
    switch Bundle.main.object(forInfoDictionaryKey: "APNsEnvironment") as? String {
    case "production": "production"
    case "development": "sandbox"
    default: nil
    }
  }
}

@MainActor @Observable
final class NotificationService {
  private let system: any NotificationSystem
  private let defaults: UserDefaults
  private let installationID: String
  @ObservationIgnored var prepareWorkspace: (@MainActor () async -> NotificationWorkspace?)?
  private var requestedDeviceToken = false
  private var deviceToken: String?
  private var workspace: NotificationWorkspace?
  private var registrationTask: Task<Void, Never>?
  private var generation = UUID()
  private var binding: Binding?
  private(set) var status = UNAuthorizationStatus.notDetermined
  private(set) var error: String?
  private(set) var pendingDestination: NotificationDestination?
  private var backgroundTasks: [String: Task<Bool, Never>] = [:]
  @ObservationIgnored var didSynchronize: (@MainActor (String) -> Void)?
  private var navigationRequest = UUID()
  private var openingRequest: UUID?
  private var workspaceNavigation: Task<Void, Never>?
  private enum NotificationAccount: Equatable {
    case unresolved
    case signedOut
    case user(String)
  }
  private var notificationAccount = NotificationAccount.unresolved
  private var notificationStateRevision = UUID()
  private var notificationStateTask: Task<Void, Never>?
  private var notificationStateRequest: Task<NotificationStateResponse, Error>?
  private let log = Logger(subsystem: "ai.okou.ios", category: "Notifications")

  private struct Binding: Encodable {
    let installationId: String
    let revision: Int
    let deviceToken: String
    let environment: String
  }

  init(
    system: any NotificationSystem = AppleNotificationSystem(), defaults: UserDefaults = .standard
  ) {
    self.system = system
    self.defaults = defaults
    let key = "ios-push-installation-id"
    installationID = defaults.string(forKey: key) ?? UUID().uuidString.lowercased()
    defaults.set(installationID, forKey: key)
  }

  func data(
    authentication: AuthenticationService, configuration: AppConfiguration, session: URLSession
  ) -> NotificationWorkspace? {
    guard let scopeID = authentication.scopeID, let userID = authentication.userID,
      let workspaceID = authentication.activeWorkspaceID
    else { return nil }
    if let workspace, workspace.scopeID == scopeID { return workspace }
    let client = APIClient(
      baseURL: configuration.apiURL, clientVersion: configuration.appVersion, session: session
    ) {
      try await authentication.accessToken(workspaceID: workspaceID, scopeID: scopeID)
    }
    let cache = ChatCache(
      scope: ChatCacheScope(
        apiBaseURL: configuration.apiURL, userID: userID, workspaceID: workspaceID))
    return NotificationWorkspace(
      scopeID: scopeID, userID: userID, workspaceID: workspaceID, client: client,
      sync: ChatSync(client: client, cache: cache))
  }

  func update(workspace: NotificationWorkspace?) async {
    if self.workspace?.scopeID != workspace?.scopeID {
      generation = UUID()
      notificationStateRequest?.cancel()
      registrationTask?.cancel()
      if self.workspace != nil { for task in backgroundTasks.values { task.cancel() } }
      didSynchronize = nil
      self.workspace = workspace
      if notificationAccount != .unresolved, let workspace {
        notificationAccount = .user(workspace.userID)
      }
      binding = nil
      if let pendingDestination, let workspace, pendingDestination.userId != workspace.userID {
        self.pendingDestination = nil
        workspaceNavigation?.cancel()
        workspaceNavigation = nil
        navigationRequest = UUID()
      }
    }
    await refreshRegistration()
    requestNotificationStateRefresh()
  }

  func enable() async {
    do {
      guard let workspace else { return }
      let status = await system.authorizationStatus()
      guard self.workspace?.scopeID == workspace.scopeID, !Task.isCancelled
      else { return }
      if status != .notDetermined {
        await system.openSettings()
        return
      }
      if status == .notDetermined { _ = try await system.requestAuthorization() }
      await refreshRegistration()
    } catch { self.error = error.localizedDescription }
  }

  func didRegister(deviceToken: Data) {
    // The OS supplies the token again on launch; no persisted token is authoritative.
    self.deviceToken = deviceToken.map { String(format: "%02x", $0) }.joined()
    registrationTask?.cancel()
    registrationTask = Task { await refreshRegistration() }
  }

  func registrationFailed(_ error: Error) {
    requestedDeviceToken = false
    self.error = error.localizedDescription
  }

  func refreshRegistration() async {
    let generation = generation
    let workspace = workspace
    let status = await system.authorizationStatus()
    guard self.generation == generation, !Task.isCancelled else { return }
    self.status = status
    guard let workspace else { return }
    do {
      let authorized = status == .authorized || status == .provisional || status == .ephemeral
      guard authorized else {
        try await unregister()
        return
      }
      if !requestedDeviceToken {
        requestedDeviceToken = true
        system.register()
      }
      guard let deviceToken, let environment = system.environment else { return }
      if binding?.deviceToken == deviceToken && binding?.environment == environment { return }
      let next = nextBinding(deviceToken: deviceToken, environment: environment)
      // Save the attempt before I/O so sign-out can fence even an uncertain write.
      binding = next
      defaults.set(true, forKey: "ios-push-registration-attempted")
      _ = try await workspace.client.data(
        "/api/ios-push-registrations", method: "POST", body: JSONEncoder().encode(next))
      try Task.checkCancellation()
      guard self.generation == generation else { return }
      error = nil
      requestNotificationStateRefresh()
    } catch {
      guard self.generation == generation, !Task.isCancelled else { return }
      binding = nil
      self.error = error.localizedDescription
    }
  }

  func signOut(authentication: AuthenticationService) async throws {
    let scopeID = authentication.scopeID
    workspaceNavigation?.cancel()
    workspaceNavigation = nil
    pendingDestination = nil
    do { try await unregister() } catch {
      log.error(
        "Cannot unregister notification binding before session revocation: \(error.localizedDescription, privacy: .public)"
      )
    }
    guard authentication.scopeID == scopeID else {
      throw AuthenticationService.AuthenticationError.workspaceChanged
    }
    try await authentication.signOut()
    await update(workspace: nil)
    await refreshNotificationState(userID: nil)
  }

  func unregister() async throws {
    guard let workspace, binding != nil || defaults.bool(forKey: "ios-push-registration-attempted")
    else { return }
    generation = UUID()
    let generation = generation
    registrationTask?.cancel()
    for task in backgroundTasks.values { task.cancel() }
    let next = Unregistration(installationId: installationID, revision: nextRevision())
    binding = nil
    _ = try await workspace.client.data(
      "/api/ios-push-registrations", method: "DELETE", body: JSONEncoder().encode(next))
    guard self.generation == generation, !Task.isCancelled else { return }
    defaults.set(false, forKey: "ios-push-registration-attempted")
  }

  private struct Unregistration: Encodable {
    let installationId: String
    let revision: Int
  }

  private func nextRevision() -> Int {
    let revision = defaults.integer(forKey: "ios-push-revision") + 1
    defaults.set(revision, forKey: "ios-push-revision")
    return revision
  }

  private func nextBinding(deviceToken: String, environment: String) -> Binding {
    Binding(
      installationId: installationID, revision: nextRevision(), deviceToken: deviceToken,
      environment: environment)
  }

  func refreshNotificationState(userID: String?) async {
    let account = userID.map(NotificationAccount.user) ?? .signedOut
    if notificationAccount != account { notificationStateRequest?.cancel() }
    notificationAccount = account
    requestNotificationStateRefresh()
    await notificationStateTask?.value
  }

  /// One service-owned worker serializes OS updates and coalesces read/realtime invalidations.
  func requestNotificationStateRefresh() {
    guard notificationAccount != .unresolved else { return }
    notificationStateRevision = UUID()
    guard notificationStateTask == nil else { return }
    notificationStateTask = Task { [weak self] in
      guard let self else { return }
      defer { notificationStateTask = nil }
      while !Task.isCancelled {
        let revision = notificationStateRevision
        await reconcileNotificationState(revision: revision)
        if notificationStateRevision == revision { return }
      }
    }
  }

  private func reconcileNotificationState(revision: UUID) async {
    let account = notificationAccount
    let generation = generation
    let workspace = workspace
    func ownsRequest() -> Bool {
      !Task.isCancelled && notificationStateRevision == revision
        && notificationAccount == account && self.generation == generation
    }
    let delivered = await system.deliveredNotifications()
    guard ownsRequest() else { return }
    do {
      switch account {
      case .unresolved:
        return
      case .signedOut:
        system.removeDeliveredNotifications(identifiers: delivered.map(\.identifier))
        try await system.setBadgeCount(0)
      case .user(let userID):
        guard let workspace, workspace.userID == userID else { return }
        system.removeDeliveredNotifications(
          identifiers: delivered.filter { $0.destination.userId != userID }.map(\.identifier))
        let current = delivered.filter { $0.destination.userId == userID }
        for offset in stride(from: 0, to: max(1, current.count), by: 500) {
          let batch = Array(current.dropFirst(offset).prefix(500))
          let request = NotificationStateRequest(
            installationId: installationID, registrationRevision: binding?.revision,
            notifications: batch.map {
              NotificationStateRequest.Receipt(
                identifier: $0.identifier, threadId: $0.destination.threadId,
                runId: $0.destination.runId)
            })
          let body = try JSONEncoder().encode(request)
          let work = Task<NotificationStateResponse, Error> {
            try await workspace.client.request(
              "/api/ios-notifications/reconcile", method: "POST", body: body)
          }
          notificationStateRequest = work
          let result = await work.result
          notificationStateRequest = nil
          let response = try result.get()
          guard ownsRequest() else { return }
          let submitted = Set(batch.map(\.identifier))
          guard response.unreadCount >= 0,
            Set(response.removeIdentifiers).isSubset(of: submitted)
          else { throw APIClientError.incompatibleData }
          system.removeDeliveredNotifications(identifiers: response.removeIdentifiers)
          try await system.setBadgeCount(response.unreadCount)
          guard ownsRequest() else { return }
        }
      }
    } catch {
      guard ownsRequest() else { return }
      log.error(
        "Cannot reconcile notification read state: \(error.localizedDescription, privacy: .public)")
    }
  }

  func receiveTap(_ destination: NotificationDestination) {
    workspaceNavigation?.cancel()
    workspaceNavigation = nil
    navigationRequest = UUID()
    pendingDestination = destination
  }

  /// App ownership also resolves a notification when no workspace is active yet.
  func preparePending(authentication: AuthenticationService) {
    guard let destination = pendingDestination, !authentication.isLoading else { return }
    guard let userID = authentication.userID else { return }
    guard userID == destination.userId else {
      workspaceNavigation?.cancel()
      pendingDestination = nil
      return
    }
    guard workspaceNavigation == nil, authentication.activeWorkspaceID != destination.workspaceId
    else { return }
    let request = navigationRequest
    workspaceNavigation = Task {
      defer { if navigationRequest == request { workspaceNavigation = nil } }
      do { try await authentication.switchWorkspace(destination.workspaceId) } catch {
        guard navigationRequest == request, !Task.isCancelled else { return }
        pendingDestination = nil
        self.error = error.localizedDescription
      }
    }
  }

  /// Invoked after identity/membership startup, never by background prefetch.
  /// Returns whether the current notification opened in this workspace.
  func openPending(authentication: AuthenticationService, store: WorkspaceStore) async -> Bool {
    guard let destination = pendingDestination, !authentication.isLoading,
      let userID = authentication.userID
    else { return false }
    if let workspaceNavigation { await workspaceNavigation.value }
    guard pendingDestination == destination, !Task.isCancelled else { return false }
    let request = navigationRequest
    guard openingRequest != request else { return false }
    openingRequest = request
    defer { if openingRequest == request { openingRequest = nil } }
    guard destination.userId == userID else {
      pendingDestination = nil
      return false
    }
    do {
      try await authentication.switchWorkspace(destination.workspaceId)
      try Task.checkCancellation()
      guard navigationRequest == request, authentication.userID == userID else { return false }
      // The new workspace's root will consume the pending destination after startup.
      guard workspace?.workspaceID == destination.workspaceId else { return false }
      let opened = await store.openChatLink(
        .thread(id: destination.threadId, runID: destination.runId))
      guard navigationRequest == request, !Task.isCancelled else { return false }
      pendingDestination = nil
      return opened
    } catch {
      guard navigationRequest == request, !Task.isCancelled else { return false }
      pendingDestination = nil
      self.error = error.localizedDescription
      return false
    }
  }

  func foregroundOptions(for destination: NotificationDestination)
    -> UNNotificationPresentationOptions
  {
    guard destination.userId == workspace?.userID else { return [] }
    return destination.workspaceId == workspace?.workspaceID ? [] : [.banner, .sound]
  }

  func synchronize(_ destination: NotificationDestination) async -> Bool {
    let id = "\(destination.userId):\(destination.workspaceId):\(destination.threadId)"
    if let existing = backgroundTasks[id] { return await existing.value }
    let task = Task { @MainActor in
      await withTaskGroup(of: Bool.self) { group in
        group.addTask { await self.performSynchronization(destination) }
        group.addTask {
          try? await Task.sleep(for: .seconds(25))
          return false
        }
        let result = await group.next() ?? false
        group.cancelAll()
        return result
      }
    }
    backgroundTasks[id] = task
    let started = ContinuousClock.now
    let result = await withTaskCancellationHandler {
      await task.value
    } onCancel: {
      task.cancel()
    }
    backgroundTasks[id] = nil
    log.debug(
      "Notification cache synchronization completed in \(started.duration(to: .now)); saved: \(result)"
    )
    return result && !Task.isCancelled
  }
  private func performSynchronization(_ destination: NotificationDestination) async -> Bool {
    if let prepareWorkspace {
      let prepared = await prepareWorkspace()
      guard !Task.isCancelled else { return false }
      if workspace?.scopeID != prepared?.scopeID { await update(workspace: prepared) }
    }
    guard let workspace, destination.userId == workspace.userID,
      destination.workspaceId == workspace.workspaceID, !Task.isCancelled
    else { return false }
    let generation = generation
    do {
      try await workspace.sync.prefetchHistory(threadID: destination.threadId)
      try Task.checkCancellation()
      guard self.generation == generation else { return false }
      didSynchronize?(destination.threadId)
      return true
    } catch { return false }
  }

}
