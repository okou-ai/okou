import ClerkKit
import SwiftUI
import Vision
import XCTest

@testable import Okou

@MainActor
final class AuthenticationStartupTests: XCTestCase {
  func testOverlappingRefreshKeepsStartupUntilLatestMembershipsAreVerified() async throws {
    let h = try await harness()
    await h.fixture.memberships.hold()
    let initial = h.refresh()
    try await waitForRequests(1, at: h.fixture.memberships)
    let foreground = h.refresh()
    try await waitForRequests(2, at: h.fixture.memberships)
    await h.fixture.memberships.release(1)
    await initial.value
    await hostingPresentationFrame()
    XCTAssertNotNil(startup(in: h.view))
    XCTAssertNil(composer(in: h.view))
    XCTAssertFalse(try text(h.window).localizedCaseInsensitiveContains("Choose a workspace"))
    attach(h.window, name: "Latest membership response still pending")
    await h.fixture.memberships.releaseAll()
    await foreground.value
    try await assertChat(h)
  }

  func testSinglePendingWorkspaceActivatesBeforeStartupExits() async throws {
    let h = try await harness {
      $0.activeWorkspaceID = nil
      $0.pending = true
    }
    let previous = await h.fixture.activation.count
    await h.fixture.activation.hold()
    let initial = h.refresh()
    try await waitForRequests(previous + 1, at: h.fixture.activation)
    await hostingPresentationFrame()
    XCTAssertNotNil(startup(in: h.view))
    XCTAssertNil(composer(in: h.view))
    XCTAssertFalse(try text(h.window).localizedCaseInsensitiveContains("Choose a workspace"))
    attach(h.window, name: "Single workspace activation still pending")
    await h.fixture.activation.releaseAll()
    await initial.value
    try await assertChat(h)
  }

  func testExistingValidWorkspaceWithMultipleMembershipsEntersChatDirectly() async throws {
    let h = try await harness { $0.workspaceIDs = ["org_one", "org_two"] }
    await h.refresh().value
    try await assertChat(h)
  }

  func testMultipleWorkspacesWaitForUserSelection() async throws {
    let h = try await harness {
      $0.activeWorkspaceID = nil
      $0.pending = true
      $0.workspaceIDs = ["org_one", "org_two"]
    }
    await h.refresh().value
    try await assertTexts(["Choose a workspace", "First workspace", "Second workspace"], in: h)
    XCTAssertNil(composer(in: h.view))
    try await h.authentication.switchWorkspace("org_two")
    try await assertChat(h)
  }

  func testNoWorkspaceShowsSetupAndCanSignOut() async throws {
    let h = try await harness {
      $0.activeWorkspaceID = nil
      $0.workspaceIDs = []
    }
    await h.refresh().value
    try await assertTexts(["Finish setting up your workspace", "Open Okou on the web"], in: h)
    try await h.authentication.signOut()
    try await assertText("Sign in", in: h)
    XCTAssertNil(composer(in: h.view))
  }

  func testMembershipFailureShowsErrorAndRetryCanEnterChat() async throws {
    let h = try await harness { $0.failMemberships = true }
    await h.refresh().value
    let failure = try await assertTexts(["Memberships unavailable", "Try again"], in: h)
    XCTAssertFalse(failure.localizedCaseInsensitiveContains("Finish setting up"), failure)
    h.fixture.state.withLock { $0.failMemberships = false }
    await h.refresh().value
    try await assertChat(h)
  }

  func testAutomaticActivationFailureShowsErrorAndRetryCanEnterChat() async throws {
    let h = try await harness {
      $0.activeWorkspaceID = nil
      $0.failActivation = true
    }
    await h.refresh().value
    try await assertTexts(["Activation unavailable", "Try again"], in: h)
    h.fixture.state.withLock { $0.failActivation = false }
    await h.refresh().value
    try await assertChat(h)
  }

  func testForegroundRefreshPreservesMountedChatAndDraft() async throws {
    let h = try await harness()
    await h.refresh().value
    try await assertChat(h)
    let original = try XCTUnwrap(composer(in: h.view))
    original.insertText("Keep this draft")
    let previous = await h.fixture.memberships.count
    await h.fixture.memberships.hold()
    let foreground = h.refresh()
    try await waitForRequests(previous + 1, at: h.fixture.memberships)
    await hostingPresentationFrame()
    XCTAssertTrue(composer(in: h.view) === original)
    XCTAssertNil(startup(in: h.view))
    await h.fixture.memberships.releaseAll()
    await foreground.value
    XCTAssertTrue(composer(in: h.view) === original)
    XCTAssertEqual(original.text, "Keep this draft")
  }

  func testCancelledInitialRefreshCanBeRetried() async throws {
    let h = try await harness()
    await h.fixture.memberships.hold()
    let cancelled = h.refresh()
    try await waitForRequests(1, at: h.fixture.memberships)
    cancelled.cancel()
    await h.fixture.memberships.releaseAll()
    await cancelled.value
    await h.refresh().value
    try await assertChat(h)
  }

  func testSignOutDuringMembershipReadRejectsOldScopeAndStaleResponse() async throws {
    let h = try await harness()
    h.start()
    try await assertChat(h)
    let scope = try XCTUnwrap(h.authentication.scopeID)
    let previous = await h.fixture.memberships.count
    await h.fixture.memberships.hold()
    let foreground = h.refresh()
    try await waitForRequests(previous + 1, at: h.fixture.memberships)
    try await h.authentication.signOut()
    try await assertText("Sign in", in: h)
    await assertRejectedToken(h, scope: scope)
    await h.fixture.memberships.releaseAll()
    await foreground.value
    try await assertText("Sign in", in: h)
    XCTAssertNil(composer(in: h.view))
  }

  func testAccountChangeCannotReuseOldMembershipsWhileNewMembershipsArePending() async throws {
    let h = try await harness()
    h.start()
    try await assertChat(h)
    let scope = try XCTUnwrap(h.authentication.scopeID)
    let previous = await h.fixture.memberships.count
    await h.fixture.memberships.hold()
    let foreground = h.refresh()
    try await waitForRequests(previous + 1, at: h.fixture.memberships)
    h.fixture.state.withLock {
      $0.userID = "user_replacement_" + UUID().uuidString
      $0.sessionID = "sess_replacement_" + UUID().uuidString
      $0.activeWorkspaceID = "org_two"
      $0.workspaceIDs = ["org_two"]
    }
    try await h.authentication.clerk?.refreshClient()
    try await waitForRequests(previous + 2, at: h.fixture.memberships)
    await h.fixture.memberships.release(previous + 1)
    await foreground.value
    await hostingPresentationFrame()
    XCTAssertNotNil(startup(in: h.view))
    XCTAssertNil(composer(in: h.view))
    await assertRejectedToken(h, scope: scope)
    await h.fixture.memberships.releaseAll()
    try await assertChat(h)
    try await assertText("Replacement", in: h)
  }

  func testRemovedWorkspaceRequiresSelectionAndRejectsItsOldScope() async throws {
    let h = try await harness { $0.workspaceIDs = ["org_one", "org_two"] }
    await h.refresh().value
    try await assertChat(h)
    let scope = try XCTUnwrap(h.authentication.scopeID)
    h.fixture.state.withLock { $0.workspaceIDs = ["org_two", "org_three"] }
    await h.refresh().value
    try await assertText("Choose a workspace", in: h)
    await assertRejectedToken(h, scope: scope)
    try await h.authentication.switchWorkspace("org_two")
    try await assertChat(h)
  }

  private func harness(_ configure: (inout AuthenticationHTTPFixture.State) -> Void = { _ in })
    async throws -> AuthenticationStartupHarness
  {
    let fixture = try AuthenticationHTTPFixture()
    fixture.state.withLock { configure(&$0) }
    let authentication = try await fixture.authentication()
    let h = try AuthenticationStartupHarness(fixture: fixture, authentication: authentication)
    addTeardownBlock { await h.close() }
    return h
  }

  private func assertChat(_ h: AuthenticationStartupHarness) async throws {
    try await eventually(
      message: "Chat did not mount: \(h.authentication.errorMessage ?? "no error")"
    ) {
      self.composer(in: h.view) != nil && self.startup(in: h.view) == nil
    }
    attach(h.window, name: "Chat after session and workspace restoration")
  }

  @discardableResult
  private func assertText(_ expected: String, in h: AuthenticationStartupHarness) async throws
    -> String
  {
    try await assertTexts([expected], in: h)
  }

  @discardableResult
  private func assertTexts(_ expected: [String], in h: AuthenticationStartupHarness) async throws
    -> String
  {
    var observed = ""
    let matches = { expected.allSatisfy { observed.localizedCaseInsensitiveContains($0) } }
    // Require the complete screen's content from one frame, then reuse that successful
    // observation for eventually's final assertion instead of running Vision again.
    try await eventually(message: "Expected rendered text: \(expected); recognized: \(observed)") {
      if matches() { return true }
      observed = (try? self.text(h.window)) ?? ""
      return matches()
    }
    attach(h.window, name: expected.joined(separator: "; "))
    return observed
  }

  private func assertRejectedToken(_ h: AuthenticationStartupHarness, scope: String) async {
    do {
      _ = try await h.authentication.accessToken(workspaceID: "org_one", scopeID: scope)
      XCTFail("An obsolete account/workspace scope must not receive a token")
    } catch {
      XCTAssertNotNil(error as? AuthenticationService.AuthenticationError)
    }
  }

  private func startup(in view: UIView) -> StartupWordmarkView? {
    (view as? StartupWordmarkView) ?? view.subviews.compactMap { startup(in: $0) }.first
  }

  private func composer(in view: UIView) -> ComposerTextView? {
    (view as? ComposerTextView) ?? view.subviews.compactMap { composer(in: $0) }.first
  }

  private func image(_ window: UIWindow) -> UIImage {
    UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
      window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
    }
  }

  private func text(_ window: UIWindow) throws -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["en-US"]
    try VNImageRequestHandler(cgImage: try XCTUnwrap(image(window).cgImage)).perform([request])
    // OCR line breaks follow rendered wrapping, which varies across simulator runtimes.
    return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
      .joined(separator: " ").split(whereSeparator: \.isWhitespace).joined(separator: " ")
  }

  private func attach(_ window: UIWindow, name: String) {
    let attachment = XCTAttachment(image: image(window))
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  private func waitForRequests(_ count: Int, at gate: AuthenticationRequestGate) async throws {
    let deadline = ContinuousClock.now + .seconds(5)
    while await gate.count < count && ContinuousClock.now < deadline {
      await hostingPresentationFrame()
    }
    let actual = await gate.count
    guard actual >= count else {
      XCTFail("Expected HTTP request \(count), received \(actual)")
      throw URLError(.timedOut)
    }
  }
}

@MainActor
private final class AuthenticationStartupHarness {
  let fixture: AuthenticationHTTPFixture
  let authentication: AuthenticationService
  let window: UIWindow
  private let host: UIHostingController<AppRootView>
  private var tasks: [Task<Void, Never>] = []
  var view: UIView { host.view }

  init(fixture: AuthenticationHTTPFixture, authentication: AuthenticationService) throws {
    self.fixture = fixture
    self.authentication = authentication
    host = UIHostingController(
      rootView: AppRootView(authentication: authentication, configuration: try AppConfiguration()))
    let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
    window = UIWindow(windowScene: scene)
    window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
    window.rootViewController = host
    window.makeKeyAndVisible()
    host.view.layoutIfNeeded()
  }

  func refresh() -> Task<Void, Never> {
    let task = Task { await authentication.refresh() }
    tasks.append(task)
    return task
  }

  func start() {
    tasks.append(Task { await authentication.start() })
  }

  func close() async {
    unmount(window)
    for task in tasks { task.cancel() }
    await fixture.close()
    for task in tasks { await task.value }
    try? await Clerk.clearAllKeychainItemsAndWait()
  }
}
