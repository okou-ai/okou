import ChatDataTestSupport
import ClerkKit
import Synchronization
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
    provider.state.withLock { $0.failMemberships = true }
    await authentication.refreshWorkspaces()
    XCTAssertNil(authentication.scopeID)
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

  func testMembershipPaginationPublishesTheCompleteOrderedList() async throws {
    let expected = (0..<205).map { "org_page_\($0)" }
    let (provider, authentication) = try await session {
      $0.activeWorkspaceID = expected[0]
      $0.workspaceIDs = expected
    }
    let queries = Mutex<[(String?, String?, String?)]>([])
    provider.identityOverride.withLock {
      $0 = { request in
        if request.url?.path == "/v1/me/organization_memberships" {
          let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems
          let limit = query?.first { $0.name == "limit" }?.value
          if limit == "100" {
            queries.withLock {
              $0.append(
                (
                  query?.first { $0.name == "offset" }?.value, limit,
                  query?.first { $0.name == "_clerk_session_id" }?.value
                ))
            }
          }
        }
        return nil
      }
    }

    await authentication.refresh()

    XCTAssertEqual(authentication.workspaces.map(\.id), expected)
    XCTAssertEqual(queries.withLock { $0.compactMap(\.0) }, ["0", "100", "200"])
    XCTAssertTrue(
      queries.withLock { $0.allSatisfy { $0.2 == provider.state.withLock { $0.sessionID } } })
    try await assertToken(authentication)
  }

  func testSharedMembershipReadSurvivesWorkspaceSwitchAndCancelledWaiter() async throws {
    let (provider, authentication) = try await session { $0.workspaceIDs = ["org_one", "org_two"] }
    await authentication.refresh()
    provider.state.withLock { $0.workspaceIDs.append("org_three") }
    await provider.memberships.hold()
    let refresh = try await membershipReadUntilRequest(authentication, provider: provider)
    let returned = expectation(description: "The shared waiter settles from the original HTTP")
    let settled = Mutex(false)
    let waiter = Task.immediate {
      await authentication.refreshWorkspaces()
      settled.withLock { $0 = true }
      returned.fulfill()
    }
    addTeardownBlock {
      waiter.cancel()
      await provider.memberships.releaseAll()
      await waiter.value
    }
    waiter.cancel()
    try await authentication.switchWorkspace("org_two")
    try await assertToken(authentication)
    await provider.memberships.release(refresh.request)
    await fulfillment(of: [returned], timeout: 3)
    guard settled.withLock({ $0 }) else { return }
    await refresh.task.value
    await waiter.value
    XCTAssertEqual(authentication.workspaces.map(\.id), ["org_one", "org_two", "org_three"])
    XCTAssertEqual(authentication.activeWorkspaceID, "org_two")
    try await assertToken(authentication)
  }

  func testLateSingleMembershipSnapshotCannotReplaceANewerSDKWorkspaceChoice() async throws {
    let (provider, authentication) = try await session { $0.workspaceIDs = ["org_one", "org_two"] }
    await authentication.refresh()
    provider.state.withLock { $0.workspaceIDs = ["org_one"] }
    await provider.memberships.hold()
    let refresh = try await membershipReadUntilRequest(authentication, provider: provider)
    // The provider re-adds the membership before confirming the user's selection,
    // while its earlier membership response is still pending on the wire.
    provider.state.withLock { $0.workspaceIDs = ["org_one", "org_two"] }
    try await authentication.switchWorkspace("org_two")
    let recheck = expectation(description: "A newer SDK choice gets fresh membership verification")
    let observation = await provider.memberships.observeRequests()
    let request = Mutex<Int?>(nil)
    let observer = Task {
      for await arrival in observation.arrivals {
        request.withLock { $0 = arrival }
        recheck.fulfill()
        return
      }
    }
    addTeardownBlock {
      await provider.memberships.stopObserving(observation.id)
      observer.cancel()
      await observer.value
    }
    await provider.memberships.release(refresh.request)
    await fulfillment(of: [recheck], timeout: 3)
    await provider.memberships.stopObserving(observation.id)
    await observer.value
    let fresh = try XCTUnwrap(
      request.withLock { $0 }, "The old list must not override SDK selection")
    XCTAssertEqual(authentication.activeWorkspaceID, "org_two")
    try await assertToken(authentication)
    await provider.memberships.release(fresh)
    await refresh.task.value

    XCTAssertEqual(authentication.activeWorkspaceID, "org_two")
    XCTAssertEqual(authentication.workspaces.map(\.id), ["org_one", "org_two"])
    try await assertToken(authentication)
  }

  func testSignOutCancelsOriginalMembershipHTTPBeforeItsServerReply() async throws {
    let (provider, authentication) = try await session()
    await authentication.refresh()
    let oldScope = try XCTUnwrap(authentication.scopeID)
    await provider.memberships.hold()
    let refresh = try await membershipReadUntilRequest(authentication, provider: provider)
    let cancelled = expectation(description: "The original SDK membership HTTP disconnects")
    let disconnected = Mutex(false)
    provider.pendingRequestDisconnected.withLock {
      $0 = { request in
        if request.url?.path == "/v1/me/organization_memberships" {
          disconnected.withLock { $0 = true }
          cancelled.fulfill()
        }
      }
    }

    try await authentication.signOut()

    await fulfillment(of: [cancelled], timeout: 3)
    guard disconnected.withLock({ $0 }) else { return }
    await refresh.task.value
    XCTAssertTrue(authentication.workspaces.isEmpty)
    XCTAssertNil(authentication.scopeID)
    await assertRejected(authentication, workspace: "org_one", scope: oldScope)
    await provider.memberships.releaseAll()
  }

  func testReplacementAccountResolvesBeforeRetiredMembershipServerReplies() async throws {
    let (provider, authentication) = try await session()
    await authentication.refresh()
    let oldScope = try XCTUnwrap(authentication.scopeID)
    await provider.memberships.hold()
    let old = try await membershipReadUntilRequest(authentication, provider: provider)
    provider.state.withLock {
      $0.userID = "user_membership_replacement_" + UUID().uuidString
      $0.sessionID = "sess_membership_replacement_" + UUID().uuidString
      $0.activeWorkspaceID = "org_two"
      $0.workspaceIDs = ["org_two"]
    }
    try await authentication.clerk?.refreshClient()
    let current = try await membershipReadUntilRequest(authentication, provider: provider)
    let settled = expectation(description: "The new account resolves and the retired read ends")
    let completed = Mutex(false)
    let resolution = Task {
      await current.task.value
      await old.task.value
      completed.withLock { $0 = true }
      settled.fulfill()
    }
    addTeardownBlock {
      resolution.cancel()
      await provider.memberships.releaseAll()
      await resolution.value
    }
    await provider.memberships.release(current.request)
    await fulfillment(of: [settled], timeout: 3)
    guard completed.withLock({ $0 }) else { return }
    await resolution.value

    XCTAssertEqual(authentication.workspaces.map(\.id), ["org_two"])
    XCTAssertEqual(authentication.activeWorkspaceID, "org_two")
    await assertRejected(authentication, workspace: "org_one", scope: oldScope)
    try await assertToken(authentication)
    await provider.memberships.releaseAll()
  }

  func testLateMembershipPageFailureKeepsConfirmedChoicesUntilExplicitRetry() async throws {
    let (provider, authentication) = try await session()
    await authentication.refresh()
    let expected = ["org_one"] + (1..<120).map { "org_page_\($0)" }
    provider.state.withLock {
      $0.workspaceIDs = expected
      $0.membershipFailureOffset = 100
      $0.membershipFailureStatus = 403
    }
    await authentication.refreshWorkspaces()
    XCTAssertEqual(authentication.workspaces.map(\.id), ["org_one"])
    XCTAssertNotNil(authentication.errorMessage)
    do {
      try await authentication.switchWorkspace("org_page_119")
      XCTFail("An incomplete, failed membership page cannot authorize a new workspace")
    } catch let error as AuthenticationService.AuthenticationError {
      XCTAssertEqual(error, .workspaceUnavailable)
    }
    provider.state.withLock { $0.membershipFailureOffset = nil }
    XCTAssertEqual(authentication.workspaces.map(\.id), ["org_one"])
    XCTAssertNotNil(authentication.errorMessage)

    await authentication.refreshWorkspaces()

    XCTAssertEqual(authentication.workspaces.map(\.id), expected)
    XCTAssertNil(authentication.errorMessage)
    try await authentication.switchWorkspace("org_page_119")
    try await assertToken(authentication)
  }

  func testStoppingAuthenticationSubscriptionCancelsPendingMembershipHTTP() async throws {
    let (provider, authentication) = try await session()
    await authentication.refresh()
    await provider.memberships.hold()
    let observation = await provider.memberships.observeRequests()
    let began = expectation(description: "Root subscription begins its membership HTTP")
    let arrival = Mutex<Int?>(nil)
    let observer = Task {
      for await request in observation.arrivals {
        arrival.withLock { $0 = request }
        began.fulfill()
        return
      }
    }
    let stopped = expectation(description: "The root authentication subscription stops")
    let cancelled = expectation(description: "Root teardown cancels the original membership HTTP")
    provider.pendingRequestDisconnected.withLock {
      $0 = { request in
        if request.url?.path == "/v1/me/organization_memberships" { cancelled.fulfill() }
      }
    }
    let startup = Task {
      await authentication.start()
      stopped.fulfill()
      await provider.memberships.stopObserving(observation.id)
    }
    addTeardownBlock {
      startup.cancel()
      await provider.memberships.releaseAll()
      await startup.value
      await provider.memberships.stopObserving(observation.id)
      observer.cancel()
      await observer.value
    }
    await fulfillment(of: [began], timeout: 3)
    await provider.memberships.stopObserving(observation.id)
    await observer.value
    _ = try XCTUnwrap(
      arrival.withLock { $0 }, "Root subscription stopped without its membership request")

    startup.cancel()

    await fulfillment(of: [cancelled, stopped], timeout: 3)
    await provider.memberships.releaseAll()
    await startup.value
    await authentication.refresh()
    try await assertToken(authentication)
  }

  private func membershipReadUntilRequest(
    _ authentication: AuthenticationService, provider: AuthenticationHTTPFixture
  ) async throws -> (task: Task<Void, Never>, request: Int) {
    let observation = await provider.memberships.observeRequests()
    let began = expectation(description: "Membership read begins its original SDK HTTP")
    let request = Mutex<Int?>(nil)
    let observer = Task {
      for await arrival in observation.arrivals {
        request.withLock { $0 = arrival }
        began.fulfill()
        return
      }
    }
    let reading = Task {
      await authentication.refreshWorkspaces()
      await provider.memberships.stopObserving(observation.id)
    }
    addTeardownBlock {
      reading.cancel()
      await provider.memberships.releaseAll()
      await reading.value
      await provider.memberships.stopObserving(observation.id)
      observer.cancel()
      await observer.value
    }
    await fulfillment(of: [began], timeout: 3)
    await provider.memberships.stopObserving(observation.id)
    await observer.value
    return (
      reading,
      try XCTUnwrap(request.withLock { $0 }, "Membership read ended before its HTTP request")
    )
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
