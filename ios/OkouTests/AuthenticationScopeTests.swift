import ChatDataTestSupport
import ClerkKit
import XCTest

@testable import Okou

@MainActor
final class AuthenticationScopeTests: XCTestCase {
  func testWorkspaceLogoMetadataKeepsUploadedImagesDistinctFromGeneratedPlaceholders() async throws
  {
    let (_, authentication) = try await session {
      $0.workspaceIDs = ["org_one", "org_two"]
      $0.workspaceImages = ["org_one": "https://example.invalid/uploaded-logo.png"]
    }
    await authentication.refresh()
    let uploaded = try XCTUnwrap(authentication.workspaces.first(where: { $0.id == "org_one" }))
    let generated = try XCTUnwrap(authentication.workspaces.first(where: { $0.id == "org_two" }))
    XCTAssertTrue(uploaded.hasImage)
    XCTAssertEqual(uploaded.imageURL?.absoluteString, "https://example.invalid/uploaded-logo.png")
    XCTAssertFalse(generated.hasImage)
    try await assertToken(authentication)
  }

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

  func testRefreshedActiveSessionCanIssueScopedTokensWhileMembershipsLoad() async throws {
    let (provider, authentication) = try await session()
    await provider.memberships.hold()
    let refresh = try await refreshUntilRequest(authentication, at: provider.memberships)
    XCTAssertFalse(authentication.isLoading)
    XCTAssertEqual(authentication.activeWorkspaceID, "org_one")
    try await assertToken(authentication)
    await provider.memberships.releaseAll()
    await refresh.task.value
    try await assertToken(authentication)
  }

  func testOverlappingStartupAndForegroundRefreshShareIdentityRestoration() async throws {
    let (provider, authentication) = try await session()
    await provider.memberships.hold()
    let refresh = try await refreshUntilRequest(authentication, at: provider.memberships)
    let overlapping = Task.immediate { await authentication.refresh() }
    addTeardownBlock { await overlapping.value }
    await provider.memberships.releaseAll()
    await refresh.task.value
    await overlapping.value
    let membershipRequests = await provider.memberships.count()
    XCTAssertEqual(membershipRequests, refresh.request)
    try await assertToken(authentication)
  }

  func testMembershipFailureDoesNotBlockARefreshedActiveSession() async throws {
    let (_, authentication) = try await session { $0.failMemberships = true }
    await authentication.refresh()
    XCTAssertFalse(authentication.isLoading)
    XCTAssertNotNil(authentication.errorMessage)
    try await assertToken(authentication)
  }

  func testIdentityChangedDuringStartupCanResolveWhileThePreviousMembershipReadIsPending()
    async throws
  {
    let (provider, authentication) = try await session()
    await provider.memberships.hold()
    let observation = await provider.memberships.observeRequests()
    let first = expectation(description: "The initial identity is loading memberships")
    let observer = Task {
      for await _ in observation.arrivals {
        first.fulfill()
        return
      }
    }
    let startup = Task { await authentication.start() }
    addTeardownBlock {
      startup.cancel()
      await provider.memberships.releaseAll()
      await provider.memberships.stopObserving(observation.id)
      observer.cancel()
      await observer.value
      await startup.value
    }
    await fulfillment(of: [first], timeout: 3)
    // The SDK can request memberships before the app's session refresh completes.
    try await waitForBusinessResult { authentication.scopeID != nil }
    let oldScope = try XCTUnwrap(authentication.scopeID)
    let replacement = expectation(description: "The replacement identity loads its own memberships")
    let sessionID = "sess_replacement_" + UUID().uuidString
    provider.identityOverride.withLock {
      $0 = { request in
        if request.url?.path == "/v1/me/organization_memberships",
          URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?
            .first(where: { $0.name == "_clerk_session_id" })?.value == sessionID
        {
          replacement.fulfill()
        }
        return nil
      }
    }
    provider.state.withLock {
      $0.userID = "user_replacement_" + UUID().uuidString
      $0.sessionID = sessionID
      $0.activeWorkspaceID = "org_two"
      $0.workspaceIDs = ["org_two"]
    }
    try await authentication.clerk?.refreshClient()
    await fulfillment(of: [replacement], timeout: 3)
    await provider.memberships.releaseAll()
    try await waitForBusinessResult { authentication.activeWorkspaceID == "org_two" }
    await assertRejected(authentication, workspace: "org_one", scope: oldScope)
    try await assertToken(authentication)
  }

  func testFailedSessionRefreshCannotAuthorizeTheCachedIdentityAndCanRetry() async throws {
    let (provider, authentication) = try await session()
    provider.identityOverride.withLock {
      $0 = { request in
        guard request.url?.path == "/v1/client" else { return nil }
        return ChatHTTPResponse(
          status: 400,
          body: #"{"errors":[{"code":"fixture_unavailable","message":"Session unavailable"}]}"#)
      }
    }
    await authentication.refresh()
    XCTAssertFalse(authentication.isLoading)
    XCTAssertNil(authentication.scopeID)
    XCTAssertNotNil(authentication.errorMessage)
    provider.state.withLock { $0.failMemberships = true }
    await authentication.refreshWorkspaces()
    XCTAssertNil(authentication.scopeID)
    provider.identityOverride.withLock { $0 = nil }
    provider.state.withLock { $0.failMemberships = false }
    await authentication.refresh()
    try await assertToken(authentication)
  }

  func testCrossWorkspaceNavigationWaitsForMembershipsWhileTheCurrentWorkspaceIsUsable()
    async throws
  {
    let (provider, authentication) = try await session { $0.workspaceIDs = ["org_one", "org_two"] }
    await provider.memberships.hold()
    let refresh = try await refreshUntilRequest(authentication, at: provider.memberships)
    try await assertToken(authentication)
    let switching = Task.immediate { try await authentication.switchWorkspace("org_two") }
    addTeardownBlock {
      switching.cancel()
      await provider.memberships.releaseAll()
      _ = try? await switching.value
    }
    XCTAssertEqual(authentication.activeWorkspaceID, "org_one")
    await provider.memberships.releaseAll()
    await refresh.task.value
    try await switching.value
    XCTAssertEqual(authentication.activeWorkspaceID, "org_two")
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
