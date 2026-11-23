import ChatData
import ClerkKit
import Foundation
import Observation

/// Owned by one account's membership resources. Activation always goes through verified memberships.
@MainActor @Observable
final class FirstWorkspaceSetup {
  private(set) var invitations: [UserOrganizationInvitation] = []
  private(set) var acceptingInvitation = false
  private var pendingWorkspaceID: String?

  func destination(
    clerk: Clerk, user: User, session: Session, memberships: [WorkspacePresentation]
  ) async throws -> String? {
    let activeID = clerk.session?.lastActiveOrganizationId
    if let activeID, memberships.contains(where: { $0.id == activeID }) {
      pendingWorkspaceID = nil
      invitations = []
      return nil
    }
    if let pendingWorkspaceID { return pendingWorkspaceID }
    // A removed active workspace can fall back to another confirmed membership.
    // Only an account with no active selection can trigger first-workspace creation.
    if activeID != nil { return memberships.count == 1 ? memberships.first?.id : nil }

    var pending: [UserOrganizationInvitation] = []
    var page = 1
    while true {
      try checkIdentity(clerk, user: user, session: session)
      let response = try await user.getOrganizationInvitations(
        page: page, pageSize: 100, status: ["pending"])
      try checkIdentity(clerk, user: user, session: session)
      pending.append(contentsOf: response.data)
      if response.data.isEmpty || pending.count >= response.totalCount { break }
      page += 1
    }
    guard clerk.session?.lastActiveOrganizationId == nil else { return nil }
    invitations = pending
    guard pending.isEmpty, !acceptingInvitation else { return nil }
    if let pendingWorkspaceID { return pendingWorkspaceID }
    if !memberships.isEmpty { return memberships.count == 1 ? memberships.first?.id : nil }
    guard user.createOrganizationEnabled else { return nil }
    let organization = try await clerk.organizations.create(name: String(localized: "My Workspace"))
    try checkIdentity(clerk, user: user, session: session)
    pendingWorkspaceID = organization.id
    return organization.id
  }

  func didActivate(_ workspaceID: String) {
    if pendingWorkspaceID == workspaceID { pendingWorkspaceID = nil }
  }

  func accept(_ invitation: UserOrganizationInvitation, clerk: Clerk, user: User, session: Session)
    async throws
  {
    try checkIdentity(clerk, user: user, session: session)
    guard !acceptingInvitation, invitations.contains(where: { $0.id == invitation.id }) else {
      throw AuthenticationError.workspaceChanged
    }
    acceptingInvitation = true
    defer { acceptingInvitation = false }
    let accepted = try await invitation.accept()
    try checkIdentity(clerk, user: user, session: session)
    pendingWorkspaceID = accepted.publicOrganizationData.id
    invitations.removeAll { $0.id == invitation.id }
  }

  private func checkIdentity(_ clerk: Clerk, user: User, session: Session) throws {
    try Task.checkCancellation()
    guard clerk.user?.id == user.id, clerk.session?.id == session.id else {
      throw CancellationError()
    }
  }
}
