import ClerkKit
import Foundation
import Observation

@MainActor
@Observable
final class AuthenticationService {
  struct Workspace: Identifiable, Equatable, Sendable {
    let id: String
    let name: String
  }

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
  private var isRestoringSession = true
  private var clientRefreshGeneration = 0
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
    // A restored identity is not ready until membership validation and any
    // automatic activation finish. Refreshing the same identity keeps chat mounted.
    guard let identity = workspaceIdentity,
      isAuthenticated || identity.status == .pending
    else { return false }
    return resolvedWorkspaceIdentity != identity
  }

  var isSwitchingWorkspace: Bool {
    guard let workspaceSwitch else { return false }
    return workspaceSwitch.sessionID == clerk?.session?.id && workspaceSwitch.userID == userID
  }

  init(clerk: Clerk) {
    self.clerk = clerk
  }

  init(publishableKey: String? = nil) {
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
    clerk = Clerk.configure(publishableKey: key, options: .init(telemetryEnabled: false))
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

  var activeWorkspaceID: String? {
    guard isAuthenticated,
      !isSwitchingWorkspace,
      workspacesSessionID == clerk?.session?.id,
      workspacesUserID == userID,
      let id = clerk?.session?.lastActiveOrganizationId,
      workspaces.contains(where: { $0.id == id })
    else { return nil }
    return id
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
    let events = clerk.auth.events
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
          clearWorkspaces()
        default:
          break
        }
      }
      group.cancelAll()
    }
  }

  func refresh() async {
    guard let clerk else { return }
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
      guard generation == clientRefreshGeneration else { return }
      try await clerk.refreshClient()
      try Task.checkCancellation()
      guard generation == clientRefreshGeneration else { return }
      await refreshWorkspaces()
    } catch is CancellationError {
      return
    } catch {
      guard generation == clientRefreshGeneration, startingIdentity == workspaceIdentity else {
        return
      }
      resolvedWorkspaceIdentity = workspaceIdentity
      errorMessage = error.localizedDescription
    }
  }

  func refreshWorkspaces() async {
    refreshGeneration += 1
    let generation = refreshGeneration
    guard let clerk, let user = clerk.user, let session = clerk.session else {
      clearWorkspaces()
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
      workspaces = memberships.map { Workspace(id: $0.organization.id, name: $0.organization.name) }
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
    } catch is CancellationError {
      return
    } catch {
      guard generation == refreshGeneration, workspaceIdentity == identity else { return }
      resolvedWorkspaceIdentity = identity
      errorMessage = error.localizedDescription
    }
  }

  func switchWorkspace(_ workspaceID: String) async throws {
    guard let clerk, let session = clerk.session, let userID = clerk.user?.id else {
      throw AuthenticationError.signedOut
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
    guard activeWorkspaceID == workspaceID,
      expectedScopeID == nil || expectedScopeID == scopeID
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
    clearWorkspaces()
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

  private func clearWorkspaces() {
    refreshGeneration += 1
    clientRefreshGeneration += 1
    isRestoringSession = false
    resolvedWorkspaceIdentity = nil
    workspaceSwitch = nil
    workspaces = []
    workspacesSessionID = nil
    workspacesUserID = nil
    isLoadingWorkspaces = false
  }
}
