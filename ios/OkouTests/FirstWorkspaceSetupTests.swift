import ClerkKit
import XCTest

@testable import Okou

@MainActor
final class FirstWorkspaceSetupTests: XCTestCase {
  func testNewAccountRecoversCreatedWorkspaceAfterFailedActivation() async throws {
    let (provider, authentication) = try await session {
      $0.activeWorkspaceID = nil
      $0.workspaceIDs = []
      $0.pending = true
      $0.failActivation = true
    }
    await authentication.refresh()
    XCTAssertNil(authentication.scopeID)
    XCTAssertNotNil(authentication.errorMessage)
    provider.state.withLock { $0.failActivation = false }
    await authentication.refresh()
    XCTAssertEqual(authentication.activeWorkspaceID, "org_created")
    XCTAssertEqual(provider.state.withLock { $0.createdWorkspaces }, 1)
    try await assertToken(authentication)
  }

  func testPendingInvitationJoinsTeamWithoutCreatingAnotherWorkspace() async throws {
    let (provider, authentication) = try await session {
      $0.activeWorkspaceID = nil
      $0.workspaceIDs = []
      $0.pending = true
      $0.hasInvitation = true
    }
    await authentication.refresh()
    XCTAssertNil(authentication.scopeID)
    let invitation = try XCTUnwrap(authentication.membershipResources?.setup.invitations.first)
    try await authentication.acceptInvitation(invitation)
    XCTAssertEqual(authentication.activeWorkspaceID, invitation.publicOrganizationData.id)
    XCTAssertEqual(provider.state.withLock { $0.createdWorkspaces }, 0)
    try await assertToken(authentication)
  }

  func testCreationDisabledLeavesAccountWaitingForInvitation() async throws {
    let (provider, authentication) = try await session {
      $0.activeWorkspaceID = nil
      $0.workspaceIDs = []
      $0.pending = true
      $0.canCreateWorkspace = false
    }
    await authentication.refresh()
    XCTAssertTrue(authentication.needsWorkspaceSelection)
    XCTAssertNil(authentication.scopeID)
    XCTAssertEqual(provider.state.withLock { $0.createdWorkspaces }, 0)
  }
}
