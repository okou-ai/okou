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
    XCTAssertNil(authentication.presentationScopeID)
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
      if activation {
        XCTAssertNotNil(authentication.errorMessage)
      } else {
        await assertMembershipFailure(authentication)
      }
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

  func testRestoredHomeScopeIsStableWhileRequestsWaitForIdentityButNotMemberships() async throws {
    let (provider, authentication) = try await session()
    let presentation = try XCTUnwrap(authentication.presentationScopeID)
    XCTAssertEqual(authentication.presentationWorkspaceID, "org_one")
    XCTAssertNil(authentication.scopeID)
    await provider.clientReads.hold()
    await provider.memberships.hold()
    let refresh = try await refreshUntilRequest(authentication, at: provider.clientReads)
    let authorized = expectation(description: "Scoped request resumes after identity verification")
    let token = Task.immediate {
      let value = try await authentication.accessToken(
        workspaceID: "org_one", scopeID: presentation)
      authorized.fulfill()
      return value
    }
    addTeardownBlock {
      token.cancel()
      await provider.clientReads.releaseAll()
      await provider.memberships.releaseAll()
      _ = try? await token.value
    }
    XCTAssertNil(authentication.scopeID)
    XCTAssertEqual(authentication.presentationScopeID, presentation)
    await provider.clientReads.releaseAll()
    await fulfillment(of: [authorized], timeout: 3)
    let value = try await token.value
    XCTAssertFalse(value.isEmpty)
    XCTAssertEqual(authentication.scopeID, presentation)
    XCTAssertEqual(authentication.presentationScopeID, presentation)
    await provider.memberships.releaseAll()
    await refresh.task.value
  }

  func testSigningOutDuringIdentityRestorationRejectsTheQueuedRequest() async throws {
    let (provider, authentication) = try await session()
    let scope = try XCTUnwrap(authentication.presentationScopeID)
    await provider.clientReads.hold()
    let refresh = try await refreshUntilRequest(authentication, at: provider.clientReads)
    let token = Task.immediate {
      try await authentication.accessToken(workspaceID: "org_one", scopeID: scope)
    }
    addTeardownBlock {
      await provider.clientReads.releaseAll()
      _ = try? await token.value
    }
    try await authentication.signOut()
    XCTAssertNil(authentication.presentationScopeID)
    await provider.clientReads.releaseAll()
    await refresh.task.value
    do {
      _ = try await token.value
      XCTFail("A request queued in a signed-out scope must not receive credentials")
    } catch {}
    XCTAssertNil(authentication.scopeID)
  }

  func testIdentityReplacementDuringRestorationRejectsThePreviousHomeScope() async throws {
    let (provider, authentication) = try await session()
    let scope = try XCTUnwrap(authentication.presentationScopeID)
    await provider.clientReads.hold()
    let refresh = try await refreshUntilRequest(authentication, at: provider.clientReads)
    let token = Task.immediate {
      try await authentication.accessToken(workspaceID: "org_one", scopeID: scope)
    }
    addTeardownBlock {
      await provider.clientReads.releaseAll()
      _ = try? await token.value
    }
    provider.state.withLock {
      $0.userID = "user_replacement_" + UUID().uuidString
      $0.sessionID = "sess_replacement_" + UUID().uuidString
      $0.activeWorkspaceID = "org_two"
      $0.workspaceIDs = ["org_two"]
    }
    await provider.clientReads.releaseAll()
    await refresh.task.value
    do {
      _ = try await token.value
      XCTFail("A request queued in another account must not receive its credentials")
    } catch let error as AuthenticationService.AuthenticationError {
      XCTAssertEqual(error, .workspaceChanged)
    }
    XCTAssertNotEqual(authentication.presentationScopeID, scope)
    try await assertToken(authentication)
  }

  func testOverlappingStartupAndForegroundRefreshShareIdentityRestoration() async throws {
    let (provider, authentication) = try await session()
    await provider.memberships.hold()
    let refresh = try await refreshUntilRequest(authentication, at: provider.memberships)
    // The server changes after capturing the held response. Both consumers must
    // finish with that original result, not a second read of the changed server.
    provider.state.withLock { $0.workspaceIDs = ["org_two"] }
    let overlapping = Task.immediate { await authentication.refresh() }
    addTeardownBlock { await overlapping.value }
    await provider.memberships.releaseAll()
    await refresh.task.value
    await overlapping.value
    let resources = try XCTUnwrap(authentication.accountResources)
    let workspaces = try await resources.read()
    XCTAssertEqual(workspaces.map(\.id), ["org_one"])
    try await assertToken(authentication)
  }

  func testMembershipFailureDoesNotBlockARefreshedActiveSession() async throws {
    let (_, authentication) = try await session { $0.failMemberships = true }
    await authentication.refresh()
    XCTAssertFalse(authentication.isLoading)
    await assertMembershipFailure(authentication)
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
    let presentation = try XCTUnwrap(authentication.presentationScopeID)
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
    XCTAssertEqual(authentication.presentationScopeID, presentation)
    XCTAssertNotNil(authentication.errorMessage)
    // A successful membership read is still not SDK identity verification.
    await authentication.refreshWorkspaces()
    XCTAssertEqual(authentication.workspaces.map(\.id), ["org_one"])
    XCTAssertNil(authentication.scopeID)
    do {
      _ = try await authentication.accessToken(workspaceID: "org_one", scopeID: presentation)
      XCTFail("Membership success cannot authorize a session whose SDK restoration failed")
    } catch {}
    provider.identityOverride.withLock { $0 = nil }
    provider.state.withLock { $0.failMemberships = false }
    await authentication.refresh()
    try await assertToken(authentication)
    XCTAssertEqual(authentication.scopeID, presentation)
  }

  func testRevokedSessionRemovesTheRestoredHomeScope() async throws {
    let (provider, authentication) = try await session()
    XCTAssertNotNil(authentication.presentationScopeID)
    provider.state.withLock { $0.signedOut = true }
    await authentication.refresh()
    XCTAssertNil(authentication.presentationScopeID)
    XCTAssertNil(authentication.scopeID)
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

  func testCancelledRefreshWaiterLeavesTheSharedMembershipReadUsable() async throws {
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

  func testPaginatedMembershipsAreCompleteAndOrderedForOverlappingConsumers() async throws {
    let expected = (0..<205).map { "org_page_\($0)" }
    let (provider, authentication) = try await session {
      $0.workspaceIDs = expected
      $0.activeWorkspaceID = expected[0]
    }
    await provider.memberships.hold()
    let refresh = try await refreshUntilRequest(authentication, at: provider.memberships)
    let resources = try XCTUnwrap(authentication.accountResources)
    let first = Task.immediate { try await resources.read() }
    let second = Task.immediate { try await resources.read() }
    addTeardownBlock {
      first.cancel()
      second.cancel()
      await provider.memberships.releaseAll()
      _ = try? await first.value
      _ = try? await second.value
    }
    first.cancel()
    await provider.memberships.releaseAll()
    await refresh.task.value
    let workspaces = try await second.value
    XCTAssertEqual(workspaces.map(\.id), expected)
    XCTAssertEqual(authentication.workspaces.map(\.id), expected)
    do {
      _ = try await first.value
      XCTFail("The cancelled waiter must detach from the shared read")
    } catch is CancellationError {}
    try await authentication.switchWorkspace(expected[204])
    try await assertToken(authentication)
  }

  func testFailedMembershipReadStaysFailedUntilExplicitRetry() async throws {
    let (provider, authentication) = try await session { $0.failMemberships = true }
    await authentication.refresh()
    let resources = try XCTUnwrap(authentication.accountResources)
    await assertMembershipFailure(authentication)
    provider.state.withLock { $0.failMemberships = false }
    // Observing the same resource is not permission to retry a failed request.
    await assertMembershipFailure(authentication)
    await authentication.refreshWorkspaces()
    let workspaces = try await resources.read()
    XCTAssertEqual(workspaces.map(\.id), ["org_one"])
    try await assertToken(authentication)
  }

  func testWorkspaceSwitchKeepsPendingAccountReadAndSignOutRetiresIt() async throws {
    let (provider, authentication) = try await session { $0.workspaceIDs = ["org_one", "org_two"] }
    await authentication.refresh()
    let resources = try XCTUnwrap(authentication.accountResources)
    await provider.memberships.hold()
    let refresh = try await refreshUntilRequest(authentication, at: provider.memberships)
    let read = try resources.store.get(resources.value)
    try await authentication.switchWorkspace("org_two")
    XCTAssertEqual(authentication.activeWorkspaceID, "org_two")
    try await assertToken(authentication)
    await provider.memberships.releaseAll()
    await refresh.task.value
    let workspaces = try await read.value
    XCTAssertEqual(workspaces.map(\.id), ["org_one", "org_two"])
    // The old workspace's read remains usable after the native workspace owner is replaced.
    let shared = try await resources.read()
    XCTAssertEqual(shared, workspaces)
    provider.state.withLock { $0.failMemberships = true }
    await authentication.refreshWorkspaces()
    await assertMembershipFailure(authentication)
    XCTAssertEqual(authentication.workspaces, workspaces)
    // Confirmation remains useful for selection, while SDK activation still decides access.
    try await authentication.switchWorkspace("org_one")
    try await assertToken(authentication)
    try await authentication.signOut()
    do {
      _ = try await resources.read()
      XCTFail("A retired account resource must reject future reads")
    } catch is CancellationError {}
    XCTAssertNil(resources.confirmed)
  }

  func testSessionReplacementRetiresOriginalPaginationAndPublishesOnlyTheNewAccount() async throws {
    let (provider, authentication) = try await session()
    await authentication.refresh()
    let previous = try XCTUnwrap(authentication.accountResources)
    await provider.memberships.hold()
    let refresh = try await refreshUntilRequest(authentication, at: provider.memberships)
    let original = try previous.store.get(previous.value)
    provider.state.withLock {
      $0.sessionID = "sess_replacement_" + UUID().uuidString
      $0.workspaceIDs = ["org_two"]
      $0.activeWorkspaceID = "org_two"
    }
    try await authentication.clerk?.refreshClient()
    // Native consumers cannot receive the previous graph even before auth event reconciliation.
    XCTAssertNil(authentication.accountResources)
    let replacement = Task.immediate { await authentication.refresh() }
    addTeardownBlock {
      replacement.cancel()
      await provider.memberships.releaseAll()
      await replacement.value
    }
    await provider.memberships.releaseAll()
    await refresh.task.value
    await replacement.value
    XCTAssertTrue(original.isCancelled)
    do {
      _ = try await original.value
      XCTFail("Old pagination must be cancelled and cannot publish into its retired owner")
    } catch {}
    do {
      _ = try await previous.read()
      XCTFail("The previous session's owner must reject new I/O")
    } catch is CancellationError {}
    XCTAssertNil(previous.confirmed)
    XCTAssertEqual(authentication.workspaces.map(\.id), ["org_two"])
    try await assertToken(authentication)
  }

  func testLaterPageFailureDoesNotPublishPartialMembershipsAndRetryLoadsTheWholeList()
    async throws
  {
    let expected = ["org_one"] + (1..<205).map { "org_page_\($0)" }
    let (provider, authentication) = try await session {
      $0.workspaceIDs = expected
      $0.failMembershipOffset = 100
    }
    await authentication.refresh()
    await assertMembershipFailure(authentication)
    XCTAssertTrue(authentication.workspaces.isEmpty)
    // A refreshed SDK session still authorizes its active workspace independently.
    try await assertToken(authentication)
    provider.state.withLock { $0.failMembershipOffset = nil }
    await authentication.refreshWorkspaces()
    XCTAssertEqual(authentication.workspaces.map(\.id), expected)
    try await authentication.switchWorkspace(expected[204])
    try await assertToken(authentication)
  }

  func testRootRetirementCancelsTheOriginalReadAndRejectsFutureDemand() async throws {
    let (provider, authentication) = try await session()
    await authentication.refresh()
    await provider.memberships.hold()
    let refresh = try await refreshUntilRequest(authentication, at: provider.memberships)
    let resources = try XCTUnwrap(authentication.accountResources)
    let original = try resources.store.get(resources.value)
    let startup = Task.immediate { await authentication.start() }
    addTeardownBlock {
      startup.cancel()
      await provider.memberships.releaseAll()
      await startup.value
    }
    startup.cancel()
    try await waitForBusinessResult { original.isCancelled }
    await provider.memberships.releaseAll()
    await refresh.task.value
    await startup.value
    do {
      _ = try await resources.read()
      XCTFail("Root retirement must fence future demand on its old account resource")
    } catch is CancellationError {}
  }

  private func assertMembershipFailure(_ authentication: AuthenticationService) async {
    do {
      let resources = try XCTUnwrap(authentication.accountResources)
      _ = try await resources.read()
      XCTFail("The original membership Task must retain its error")
    } catch {}
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
