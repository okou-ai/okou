import ChatData
import ClerkKit
import Foundation
import Observation

@MainActor
@Observable
final class AuthenticationService {
  typealias Workspace = WorkspacePresentation

  enum AuthenticationError: LocalizedError {
    case notConfigured
    case signedOut
    case workspaceChanged
    case workspaceUnavailable

    var errorDescription: String? {
      switch self {
      case .notConfigured:
        String(localized: "Sign-in is not configured for this build.")
      case .signedOut:
        String(localized: "Your session has expired. Please sign in again.")
      case .workspaceChanged:
        String(
          localized: "Your account or workspace changed. Please try again in the current workspace."
        )
      case .workspaceUnavailable:
        String(
          localized:
            "This workspace is no longer available. Choose another workspace or manage access on the web."
        )
      }
    }
  }

  let clerk: Clerk?
  private(set) var presentation: IdentityPresentation?
  private let presentationDirectory: URL?
  private var isRestoringSession = true
  private var clientRefreshGeneration = 0
  private var clientRefreshTask:
    (id: UUID, identity: Task<Result<Void, Error>, Never>, task: Task<Void, Never>)?
  private var resolvedWorkspaceIdentity: WorkspaceIdentity?
  private var workspaceSwitch: (id: UUID, sessionID: String, userID: String)?
  private(set) var isLoadingWorkspaces = false
  private(set) var workspaces: [Workspace] = []
  private(set) var errorMessage: String?
  private var refreshGeneration = 0
  private var workspacesSessionID: String?
  private var workspacesUserID: String?

  private struct WorkspaceIdentity: Equatable {
    let sessionID: String
    let userID: String
    let status: Session.SessionStatus
    let workspaceID: String?
  }

  private var workspaceIdentity: WorkspaceIdentity? {
    guard let session = clerk?.session, let userID,
      session.status == .active || session.tasks?.first == .chooseOrganization
    else { return nil }
    return WorkspaceIdentity(
      sessionID: session.id, userID: userID, status: session.status,
      workspaceID: session.lastActiveOrganizationId)
  }

  var isLoading: Bool {
    if isRestoringSession { return true }
    // A refreshed active session can enter its workspace while the switcher's
    // membership list loads. Missing organizations still require resolution.
    guard let identity = workspaceIdentity,
      isAuthenticated || identity.status == .pending
    else { return false }
    return resolvedWorkspaceIdentity != identity && errorMessage == nil
  }

  var isSwitchingWorkspace: Bool {
    guard let workspaceSwitch else { return false }
    return workspaceSwitch.sessionID == clerk?.session?.id && workspaceSwitch.userID == userID
  }

  init(clerk: Clerk, presentationDirectory: URL? = nil) {
    self.clerk = clerk
    self.presentationDirectory = presentationDirectory
  }

  init(publishableKey: String? = nil) {
    presentationDirectory = nil
    let key =
      (publishableKey ?? Bundle.main.object(forInfoDictionaryKey: "ClerkPublishableKey") as? String
      ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    guard key.hasPrefix("pk_live_") || key.hasPrefix("pk_test_") else {
      clerk = nil
      isRestoringSession = false
      errorMessage = AuthenticationError.notConfigured.localizedDescription
      return
    }
    clerk = Clerk.configure(
      publishableKey: key,
      options: .init(telemetryEnabled: false, keychainConfig: PushConfiguration.keychain()))
  }

  var isAuthenticated: Bool {
    clerk?.isAuthFlowComplete == true
  }

  var userID: String? {
    clerk?.user?.id
  }

  var firstName: String? {
    clerk?.user?.firstName
  }

  struct Profile: Equatable {
    let name: String?
    let email: String?
    let imageURL: URL?
    let hasImage: Bool
  }

  var profile: Profile? {
    guard let user = clerk?.user else { return nil }
    let name = [user.firstName, user.lastName].compactMap { $0 }.joined(separator: " ")
    return Profile(
      name: name.isEmpty ? nil : name, email: user.primaryEmailAddress?.emailAddress,
      imageURL: URL(string: user.imageUrl), hasImage: user.hasImage)
  }

  func workspacePresentation(_ id: String) -> Workspace? {
    if workspacesUserID == userID, let workspace = workspaces.first(where: { $0.id == id }) {
      return workspace
    }
    if presentation?.userID == userID, let workspace = presentation?.workspace(id) {
      return workspace
    }
    let membership = clerk?.user?.organizationMemberships?.first { $0.organization.id == id }
    guard let organization = membership?.organization else { return nil }
    return Workspace(
      id: organization.id, name: organization.name,
      imageURL: URL(string: organization.imageUrl), hasImage: organization.hasImage)
  }

  func preparePresentation() async {
    guard let clerk, let userID, let workspaceID = presentationWorkspaceID else { return }
    if presentation?.userID != userID {
      let previous = presentation
      presentation = IdentityPresentation(
        userID: userID,
        cache: IdentityPresentationCache(
          environment: clerk.publishableKey, userID: userID, directory: presentationDirectory),
        workspaces: (clerk.user?.organizationMemberships ?? []).map {
          Workspace(
            id: $0.organization.id, name: $0.organization.name,
            imageURL: URL(string: $0.organization.imageUrl), hasImage: $0.organization.hasImage)
        })
      await previous?.close(removeFiles: false)
    }
    guard let presentation, presentation.userID == userID else { return }
    if workspacesSessionID == clerk.session?.id, workspacesUserID == userID {
      await presentation.replaceWorkspaces(workspaces, activeID: workspaceID)
    }
    await presentation.restore(
      workspaceID: workspaceID, profileURL: profile?.imageURL,
      hasProfileImage: profile?.hasImage ?? false)
  }

  /// A restored SDK session can present its own local cache before network verification.
  /// This does not authorize requests; accessToken waits for the refreshed identity.
  var presentationWorkspaceID: String? {
    guard isAuthenticated, let identity = workspaceIdentity, let id = identity.workspaceID
    else { return nil }
    if workspacesSessionID == identity.sessionID, workspacesUserID == identity.userID,
      !workspaces.contains(where: { $0.id == id })
    {
      return nil
    }
    return id
  }

  var activeWorkspaceID: String? {
    guard !isSwitchingWorkspace, let identity = workspaceIdentity,
      resolvedWorkspaceIdentity == identity
    else { return nil }
    return presentationWorkspaceID
  }

  var presentationScopeID: String? {
    guard let userID, let sessionID = clerk?.session?.id, let presentationWorkspaceID else {
      return nil
    }
    return "\(userID):\(sessionID):\(presentationWorkspaceID)"
  }

  /// Changes on account, session, or workspace changes; a workspace store owns one scope.
  var scopeID: String? {
    guard let userID, let sessionID = clerk?.session?.id, let activeWorkspaceID else { return nil }
    return "\(userID):\(sessionID):\(activeWorkspaceID)"
  }

  var needsWorkspaceSelection: Bool {
    guard !isLoading, let session = clerk?.session, clerk?.user != nil else { return false }
    if session.status == .pending {
      return session.tasks?.first == .chooseOrganization
    }
    return session.status == .active && activeWorkspaceID == nil
  }

  /// Own this long-lived subscription with the app's root `.task`.
  func start() async {
    guard let clerk else { return }
    defer {
      clientRefreshTask?.identity.cancel()
      clientRefreshTask?.task.cancel()
      clientRefreshTask = nil
    }
    let events = clerk.auth.events
    await withTaskCancellationHandler {
      await withDiscardingTaskGroup { group in
        group.addTask { await self.refresh() }
        for await event in events {
          guard !Task.isCancelled else { break }
          switch event {
          case .sessionChanged(let oldSession, let newSession):
            guard
              oldSession?.id != newSession?.id
                || oldSession?.user?.id != newSession?.user?.id
                || oldSession?.status != newSession?.status
                || oldSession?.lastActiveOrganizationId != newSession?.lastActiveOrganizationId
            else { continue }
            // A delayed membership response must not block sign-out or a newer identity.
            if workspaceIdentity != resolvedWorkspaceIdentity {
              group.addTask { await self.refreshWorkspaces() }
            }
          case .signedOut, .accountDeleted:
            await clearWorkspaces()
          default:
            break
          }
        }
        group.cancelAll()
      }
    } onCancel: {
      Task { @MainActor [weak self] in
        self?.clientRefreshTask?.identity.cancel()
        self?.clientRefreshTask?.task.cancel()
      }
    }
  }

  func refresh() async {
    guard clerk != nil, !Task.isCancelled else { return }
    _ = beginClientRefresh()
    await clientRefreshTask?.task.value
  }

  private func beginClientRefresh() -> Task<Result<Void, Error>, Never> {
    if let clientRefreshTask { return clientRefreshTask.identity }
    let id = UUID()
    let identity = Task { await self.restoreSession() }
    let task = Task {
      defer { if clientRefreshTask?.id == id { clientRefreshTask = nil } }
      guard case .success = await identity.value, !Task.isCancelled else { return }
      await refreshWorkspaces()
    }
    clientRefreshTask = (id, identity, task)
    return identity
  }

  private func restoreSession() async -> Result<Void, Error> {
    guard let clerk else { return .failure(AuthenticationError.notConfigured) }
    clientRefreshGeneration += 1
    let generation = clientRefreshGeneration
    let startingIdentity = workspaceIdentity
    // Keep a mounted verification/OAuth flow alive during foreground refresh.
    if clerk.environment == nil { isRestoringSession = true }
    errorMessage = nil
    defer {
      if generation == clientRefreshGeneration { isRestoringSession = false }
    }
    do {
      if clerk.environment == nil {
        try await clerk.refreshEnvironment()
      }
      try Task.checkCancellation()
      guard generation == clientRefreshGeneration else { return .failure(CancellationError()) }
      try await clerk.refreshClient()
      try Task.checkCancellation()
      guard generation == clientRefreshGeneration else { return .failure(CancellationError()) }
      if isAuthenticated, let identity = workspaceIdentity, identity.workspaceID != nil {
        resolvedWorkspaceIdentity = identity
        isRestoringSession = false
      }
      return .success(())
    } catch is CancellationError {
      return .failure(CancellationError())
    } catch {
      guard generation == clientRefreshGeneration, startingIdentity == workspaceIdentity else {
        return .failure(error)
      }
      errorMessage = error.localizedDescription
      return .failure(error)
    }
  }

  func refreshWorkspaces() async {
    refreshGeneration += 1
    let generation = refreshGeneration
    guard let clerk, let user = clerk.user, let session = clerk.session else {
      await clearWorkspaces()
      return
    }
    guard let identity = workspaceIdentity else {
      isLoadingWorkspaces = false
      return
    }
    isLoadingWorkspaces = true
    defer {
      if generation == refreshGeneration {
        isLoadingWorkspaces = false
      }
    }
    if workspacesSessionID != session.id || workspacesUserID != user.id {
      workspaces = []
      workspacesSessionID = nil
      workspacesUserID = nil
    }
    do {
      var memberships: [OrganizationMembership] = []
      var page = 1
      while true {
        let response = try await user.getOrganizationMemberships(page: page, pageSize: 100)
        try Task.checkCancellation()
        guard generation == refreshGeneration,
          clerk.session?.id == session.id,
          clerk.user?.id == user.id,
          workspaceIdentity == identity
        else { return }
        memberships.append(contentsOf: response.data)
        if response.data.isEmpty || memberships.count >= response.totalCount { break }
        page += 1
      }
      workspaces = memberships.map {
        Workspace(
          id: $0.organization.id, name: $0.organization.name,
          imageURL: URL(string: $0.organization.imageUrl), hasImage: $0.organization.hasImage)
      }
      workspacesSessionID = session.id
      workspacesUserID = user.id
      errorMessage = nil
      let activeID = clerk.session?.lastActiveOrganizationId
      if workspaces.count == 1,
        let workspace = workspaces.first,
        activeID != workspace.id
      {
        try await switchWorkspace(workspace.id)
      }
      guard generation == refreshGeneration,
        clerk.session?.id == session.id, clerk.user?.id == user.id
      else { return }
      resolvedWorkspaceIdentity = workspaceIdentity
      if presentation != nil { await preparePresentation() }
    } catch is CancellationError {
      return
    } catch {
      guard generation == refreshGeneration, workspaceIdentity == identity else { return }
      errorMessage = error.localizedDescription
    }
  }

  func switchWorkspace(_ workspaceID: String) async throws {
    guard let clerk, let session = clerk.session, let userID = clerk.user?.id else {
      throw AuthenticationError.signedOut
    }
    // A notification can target another workspace before its switcher list arrives.
    if workspacesSessionID != session.id || workspacesUserID != userID {
      await refresh()
      try Task.checkCancellation()
      guard clerk.session?.id == session.id, clerk.user?.id == userID else {
        throw AuthenticationError.workspaceChanged
      }
    }
    guard !isSwitchingWorkspace else { throw AuthenticationError.workspaceChanged }
    guard workspacesSessionID == session.id, workspacesUserID == userID,
      workspaces.contains(where: { $0.id == workspaceID })
    else {
      throw AuthenticationError.workspaceUnavailable
    }
    if activeWorkspaceID == workspaceID { return }
    let switchID = UUID()
    workspaceSwitch = (switchID, session.id, userID)
    defer {
      if workspaceSwitch?.id == switchID { workspaceSwitch = nil }
    }
    do {
      try await clerk.auth.setActive(sessionId: session.id, organizationId: workspaceID)
      try Task.checkCancellation()
      guard workspaceSwitch?.id == switchID,
        clerk.session?.id == session.id,
        clerk.user?.id == userID,
        clerk.session?.lastActiveOrganizationId == workspaceID,
        workspacesSessionID == session.id,
        workspacesUserID == userID,
        workspaces.contains(where: { $0.id == workspaceID })
      else { throw AuthenticationError.workspaceChanged }
      resolvedWorkspaceIdentity = workspaceIdentity
      errorMessage = nil
    } catch {
      if workspaceSwitch?.id == switchID,
        clerk.session?.id == session.id, clerk.user?.id == userID,
        !(error is CancellationError)
      {
        errorMessage = error.localizedDescription
      }
      throw error
    }
  }

  func accessToken(workspaceID: String, scopeID expectedScopeID: String? = nil) async throws
    -> String
  {
    guard let clerk, isAuthenticated, let session = clerk.session, let userID = clerk.user?.id
    else {
      throw AuthenticationError.signedOut
    }
    guard !isSwitchingWorkspace, presentationWorkspaceID == workspaceID,
      expectedScopeID == nil || expectedScopeID == presentationScopeID
    else { throw AuthenticationError.workspaceChanged }
    let presentedScope = presentationScopeID
    if resolvedWorkspaceIdentity != workspaceIdentity {
      let result = await beginClientRefresh().value
      try Task.checkCancellation()
      try result.get()
    }
    guard activeWorkspaceID == workspaceID,
      presentedScope == presentationScopeID,
      expectedScopeID == nil || expectedScopeID == scopeID,
      clerk.session?.id == session.id, clerk.user?.id == userID
    else { throw AuthenticationError.workspaceChanged }
    let startingScope = scopeID
    let token = try await session.getToken()
    try Task.checkCancellation()
    guard clerk.session?.id == session.id,
      clerk.user?.id == userID,
      activeWorkspaceID == workspaceID,
      scopeID == startingScope
    else { throw AuthenticationError.workspaceChanged }
    guard let token, !token.isEmpty else { throw AuthenticationError.signedOut }
    return token
  }

  func accessToken() async throws -> String {
    guard let activeWorkspaceID else { throw AuthenticationError.workspaceUnavailable }
    return try await accessToken(workspaceID: activeWorkspaceID)
  }

  func signOut() async throws {
    guard let clerk else { throw AuthenticationError.notConfigured }
    try await clerk.auth.signOut()
    await clearWorkspaces()
    errorMessage = nil
  }

  func handleURL(_ url: URL) async {
    guard let clerk else { return }
    do {
      try await clerk.handle(url)
    } catch is CancellationError {
      return
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func clearWorkspaces() async {
    let previous = presentation
    presentation = nil
    clientRefreshTask?.identity.cancel()
    clientRefreshTask?.task.cancel()
    clientRefreshTask = nil
    refreshGeneration += 1
    clientRefreshGeneration += 1
    isRestoringSession = false
    resolvedWorkspaceIdentity = nil
    workspaceSwitch = nil
    workspaces = []
    workspacesSessionID = nil
    workspacesUserID = nil
    isLoadingWorkspaces = false
    await previous?.close(removeFiles: true)
  }
}
