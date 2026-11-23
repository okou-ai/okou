import ChatData
import Foundation
import Observation

/// Creation belongs to one account/session; uncertain writes reconcile memberships first.
@MainActor @Observable
final class WorkspaceCreationStore {
  let resources: OnboardingResources
  let authentication: AuthenticationService
  var name = ""
  private(set) var isCreating = false
  private(set) var error: String?
  private var operation: Task<Void, Never>?
  private let userID: String?
  private let sessionID: String?
  private var closed = false
  private var createdWorkspaceID: String?

  init(
    authentication: AuthenticationService, configuration: AppConfiguration,
    session: URLSession = .shared
  ) {
    self.authentication = authentication
    userID = authentication.userID
    sessionID = authentication.clerk?.session?.id
    let client = APIClient(
      baseURL: configuration.apiURL, clientVersion: configuration.appVersion, session: session
    ) {
      // This client only reads the public rollout bootstrap until Clerk activates a workspace.
      throw AuthenticationError.workspaceUnavailable
    }
    resources = OnboardingResources(
      client: client, catalogURL: configuration.apiURL, locale: "en-US", didFail: { _ in })
    name = authentication.firstName.map { "\($0)'s workspace" } ?? "My workspace"
  }

  func create() async {
    guard operation == nil, !closed, !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    else { return }
    isCreating = true
    error = nil
    let task = Task { [weak self] in
      guard let self else { return }
      defer {
        isCreating = false
        operation = nil
      }
      do {
        let enabled = try await resources.service.nativeAvailability()
        try checkCurrent()
        guard enabled else {
          throw APIClientError.http(
            status: 403, message: "Workspace setup is not available in this build.")
        }
        // A previous create may have committed even if its response was lost.
        await authentication.refreshWorkspaces()
        try checkCurrent()
        if let error = authentication.errorMessage {
          throw APIClientError.http(status: 503, message: error)
        }
        if !authentication.workspaces.isEmpty { return }
        guard let clerk = authentication.clerk, let sessionID else {
          throw AuthenticationError.signedOut
        }
        let workspaceID: String
        if let existing = createdWorkspaceID {
          workspaceID = existing
        } else {
          let workspace = try await clerk.organizations.create(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines))
          try checkCurrent()
          createdWorkspaceID = workspace.id
          workspaceID = workspace.id
        }
        try await clerk.auth.setActive(sessionId: sessionID, organizationId: workspaceID)
        try checkCurrent()
        await authentication.refresh()
      } catch is CancellationError {} catch {
        if !closed { self.error = ChatRequestFailure.message(for: error) }
      }
    }
    operation = task
    await task.value
  }

  private func checkCurrent() throws {
    try Task.checkCancellation()
    guard !closed, authentication.userID == userID,
      authentication.clerk?.session?.id == sessionID
    else { throw CancellationError() }
  }

  func retryStatus() {
    do { try resources.retry(.availability) } catch {
      self.error = ChatRequestFailure.message(for: error)
    }
  }

  func close() {
    closed = true
    operation?.cancel()
    resources.close()
  }
  isolated deinit { operation?.cancel() }
}
