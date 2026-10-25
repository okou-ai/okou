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
    let refresh = try await refreshUntilRequest(authentication, at: provider.activation)
    XCTAssertNil(authentication.scopeID)
    await provider.activation.releaseAll()
    await refresh.task.value
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
    await provider.memberships.hold()
    let refresh = try await refreshUntilRequest(authentication, at: provider.memberships)
    try await authentication.signOut()
    await provider.memberships.releaseAll()
    await refresh.task.value
    await assertRejected(authentication, workspace: "org_one", scope: scope)
    XCTAssertNil(authentication.scopeID)
  }

  func testChangedAccountCannotUseThePreviousScopeAfterAnOverlappingRead() async throws {
    let (provider, authentication) = try await session()
    await authentication.refresh()
    let oldScope = try XCTUnwrap(authentication.scopeID)
    await provider.memberships.hold()
    let refreshing = try await refreshUntilRequest(authentication, at: provider.memberships)
    provider.state.withLock {
      $0.userID = "user_replacement_" + UUID().uuidString
      $0.sessionID = "sess_replacement_" + UUID().uuidString
      $0.activeWorkspaceID = "org_two"
      $0.workspaceIDs = ["org_two"]
    }
    try await authentication.clerk?.refreshClient()
    await provider.memberships.releaseAll()
    await refreshing.task.value
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
    await provider.memberships.hold()
    let first = try await refreshUntilRequest(authentication, at: provider.memberships)
    let latest = try await refreshUntilRequest(authentication, at: provider.memberships)
    await provider.memberships.release(first.request)
    await first.task.value
    XCTAssertNil(authentication.scopeID)
    await provider.memberships.releaseAll()
    await latest.task.value
    try await assertToken(authentication)
  }

  func testCancelledMembershipVerificationCanRetryWithoutReusingItsOldRead() async throws {
    let (provider, authentication) = try await session()
    await provider.memberships.hold()
    let cancelled = try await refreshUntilRequest(authentication, at: provider.memberships)
    cancelled.task.cancel()
    await provider.memberships.releaseAll()
    await cancelled.task.value
    await authentication.refresh()
    try await assertToken(authentication)
  }

  func testCompletedRefreshWithoutARequestStopsBeforeDependentActions() async throws {
    let authentication = AuthenticationService(publishableKey: "")
    let gate = AuthenticationRequestGate()
    XCTExpectFailure(
      "A completed refresh must not satisfy an identity request it never issued",
      issueMatcher: { @Sendable issue in
        issue.compactDescription.contains("Refresh completed without the expected fixture request")
      })
    var reachedDependentAction = false
    var caughtFailure = false
    do {
      _ = try await refreshUntilRequest(authentication, at: gate)
      reachedDependentAction = true
    } catch {
      caughtFailure = true
    }
    XCTAssertTrue(caughtFailure)
    XCTAssertFalse(reachedDependentAction)
    XCTAssertNotNil(authentication.errorMessage)
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

  private func refreshUntilRequest(
    _ authentication: AuthenticationService, at gate: AuthenticationRequestGate,
    file: StaticString = #filePath, line: UInt = #line
  ) async throws -> (task: Task<Void, Never>, request: Int) {
    let observation = await gate.observeRequests()
    let refresh = Task {
      await authentication.refresh()
      await gate.stopObserving(observation.id)
    }
    addTeardownBlock {
      refresh.cancel()
      await gate.releaseAll()
      await refresh.value
      await gate.stopObserving(observation.id)
    }
    var request: Int?
    for await arrival in observation.arrivals {
      request = arrival
      break
    }
    await gate.stopObserving(observation.id)
    try Task.checkCancellation()
    let observedRequest = try XCTUnwrap(
      request,
      "Refresh completed without the expected fixture request: "
        + (authentication.errorMessage ?? "no authentication error"),
      file: file, line: line)
    return (refresh, observedRequest)
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
