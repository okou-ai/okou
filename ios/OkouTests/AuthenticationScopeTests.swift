import ClerkKit
import XCTest

@testable import Okou

@MainActor
final class AuthenticationScopeTests: XCTestCase {
  func testSinglePendingWorkspaceMustBeVerifiedAndActivatedBeforeIssuingTokens() async throws {
    let (provider, authentication) = try await session {
      $0.activeWorkspaceID = nil
      $0.pending = true
    }
    await provider.activation.hold()
    let refresh = Task { await authentication.refresh() }
    addTeardownBlock {
      await provider.activation.releaseAll()
      await refresh.value
    }
    try await requestStarted(at: provider.activation)
    XCTAssertNil(authentication.scopeID)
    await provider.activation.releaseAll()
    await refresh.value
    XCTAssertEqual(authentication.activeWorkspaceID, "org_one")
    try await assertToken(authentication)
  }

  func testMultipleMembershipsRequireExplicitSelectionAndKeepAValidExistingChoice() async throws {
    let (_, authentication) = try await session {
      $0.activeWorkspaceID = nil
      $0.workspaceIDs = ["org_one", "org_two"]
    }
    await authentication.refresh()
    XCTAssertNil(authentication.scopeID)
    XCTAssertEqual(Set(authentication.workspaces.map(\.id)), ["org_one", "org_two"])
    try await authentication.switchWorkspace("org_two")
    let scope = try XCTUnwrap(authentication.scopeID)
    try await assertToken(authentication)
    await authentication.refresh()
    XCTAssertEqual(authentication.scopeID, scope)
    try await assertToken(authentication)
  }

  func testFailedMembershipOrActivationCanRetryWithoutGrantingAnUnverifiedScope() async throws {
    for activation in [false, true] {
      let (provider, authentication) = try await session {
        $0.activeWorkspaceID = nil
        $0.pending = true
        $0.failMemberships = !activation
        $0.failActivation = activation
      }
      await authentication.refresh()
      XCTAssertNil(authentication.scopeID)
      XCTAssertNotNil(authentication.errorMessage)
      provider.state.withLock {
        $0.failMemberships = false
        $0.failActivation = false
      }
      await authentication.refresh()
      try await assertToken(authentication)
    }
  }

  func testSigningOutRejectsOldTokensAfterALateMembershipResponse() async throws {
    let (provider, authentication) = try await session()
    await authentication.refresh()
    let scope = try XCTUnwrap(authentication.scopeID)
    let previous = await provider.memberships.count
    await provider.memberships.hold()
    let refresh = Task { await authentication.refresh() }
    addTeardownBlock {
      await provider.memberships.releaseAll()
      await refresh.value
    }
    try await requestStarted(at: provider.memberships, after: previous)
    try await authentication.signOut()
    await provider.memberships.releaseAll()
    await refresh.value
    await assertRejected(authentication, workspace: "org_one", scope: scope)
    XCTAssertNil(authentication.scopeID)
  }

  func testChangedAccountCannotUseThePreviousScopeAfterAnOverlappingRead() async throws {
    let (provider, authentication) = try await session()
    await authentication.refresh()
    let oldScope = try XCTUnwrap(authentication.scopeID)
    let previous = await provider.memberships.count
    await provider.memberships.hold()
    let refreshing = Task { await authentication.refresh() }
    addTeardownBlock {
      await provider.memberships.releaseAll()
      await refreshing.value
    }
    try await requestStarted(at: provider.memberships, after: previous)
    provider.state.withLock {
      $0.userID = "user_replacement_" + UUID().uuidString
      $0.sessionID = "sess_replacement_" + UUID().uuidString
      $0.activeWorkspaceID = "org_two"
      $0.workspaceIDs = ["org_two"]
    }
    try await authentication.clerk?.refreshClient()
    await provider.memberships.releaseAll()
    await refreshing.value
    await authentication.refresh()
    await assertRejected(authentication, workspace: "org_one", scope: oldScope)
    XCTAssertEqual(authentication.activeWorkspaceID, "org_two")
    try await assertToken(authentication)
  }

  func testRemovedMembershipRevokesTheOldScopeBeforeAnotherWorkspaceIsSelected() async throws {
    let (provider, authentication) = try await session { $0.workspaceIDs = ["org_one", "org_two"] }
    await authentication.refresh()
    let oldScope = try XCTUnwrap(authentication.scopeID)
    provider.state.withLock { $0.workspaceIDs = ["org_two"] }
    await authentication.refresh()
    await assertRejected(authentication, workspace: "org_one", scope: oldScope)
    try await authentication.switchWorkspace("org_two")
    try await assertToken(authentication)
  }

  func testOnlyTheLatestInitialMembershipReadCanAuthorizeTheScope() async throws {
    let (provider, authentication) = try await session()
    let previous = await provider.memberships.count
    await provider.memberships.hold()
    let first = Task { await authentication.refresh() }
    addTeardownBlock {
      await provider.memberships.releaseAll()
      await first.value
    }
    try await requestStarted(at: provider.memberships, after: previous)
    let latest = Task { await authentication.refresh() }
    addTeardownBlock {
      await provider.memberships.releaseAll()
      await latest.value
    }
    try await requestStarted(at: provider.memberships, after: previous + 1)
    await provider.memberships.release(previous + 1)
    await first.value
    XCTAssertNil(authentication.scopeID)
    await provider.memberships.releaseAll()
    await latest.value
    try await assertToken(authentication)
  }

  func testCancelledMembershipVerificationCanRetryWithoutReusingItsOldRead() async throws {
    let (provider, authentication) = try await session()
    let previous = await provider.memberships.count
    await provider.memberships.hold()
    let cancelled = Task { await authentication.refresh() }
    addTeardownBlock {
      await provider.memberships.releaseAll()
      await cancelled.value
    }
    try await requestStarted(at: provider.memberships, after: previous)
    cancelled.cancel()
    await provider.memberships.releaseAll()
    await cancelled.value
    await authentication.refresh()
    try await assertToken(authentication)
  }

  private func session(_ configure: (inout AuthenticationHTTPFixture.State) -> Void = { _ in })
    async throws -> (AuthenticationHTTPFixture, AuthenticationService)
  {
    let provider = try AuthenticationHTTPFixture()
    addTeardownBlock { await provider.close() }
    provider.state.withLock { configure(&$0) }
    let authentication = try await provider.authentication()
    addTeardownBlock { @MainActor in
      if authentication.clerk?.session != nil { try await authentication.signOut() }
      try await Clerk.clearAllKeychainItemsAndWait()
    }
    return (provider, authentication)
  }

  private func requestStarted(at gate: AuthenticationRequestGate, after count: Int = 0) async throws
  {
    let deadline = ContinuousClock.now + .seconds(3)
    while await gate.count <= count, ContinuousClock.now < deadline { await Task.yield() }
    let started = await gate.count > count
    _ = try XCTUnwrap(started ? true : nil, "Expected the external identity request to start")
  }

  private func assertToken(_ authentication: AuthenticationService) async throws {
    let workspace = try XCTUnwrap(authentication.activeWorkspaceID)
    let scope = try XCTUnwrap(authentication.scopeID)
    let token = try await authentication.accessToken(workspaceID: workspace, scopeID: scope)
    XCTAssertFalse(token.isEmpty)
  }

  private func assertRejected(
    _ authentication: AuthenticationService, workspace: String, scope: String
  ) async {
    do {
      _ = try await authentication.accessToken(workspaceID: workspace, scopeID: scope)
      XCTFail("An obsolete identity scope must not receive a token")
    } catch { XCTAssertNotNil(error as? AuthenticationService.AuthenticationError) }
  }
}
