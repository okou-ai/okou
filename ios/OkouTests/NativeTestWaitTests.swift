import SwiftUI
import XCTest

@MainActor
final class NativeTestWaitTests: XCTestCase {
  func testTimedOutPrerequisiteDoesNotContinueToDependentActions() async {
    let message = "Intentional prerequisite timeout"
    XCTExpectFailure(
      "Verify that a failed wait records an assertion and stops its caller",
      issueMatcher: { @Sendable issue in issue.compactDescription.contains(message) })
    var reachedDependentAction = false
    var caughtFailure = false
    do {
      try await eventually(timeout: .zero, message: message) { false }
      reachedDependentAction = true
    } catch {
      caughtFailure = true
    }
    XCTAssertTrue(caughtFailure)
    XCTAssertFalse(reachedDependentAction)
  }

  func testFailedHostReadinessDetachesTheWindowBeforeThrowing() async {
    let host = UIHostingController(rootView: Text("Owned native content"))
    XCTExpectFailure(
      "A readiness failure must detach its native host before returning",
      issueMatcher: { @Sendable issue in
        issue.compactDescription.contains("The native host did not become ready")
      })
    do {
      _ = try await mountNativeHost(host, timeout: .zero) { _ in false }
      XCTFail("A failed prerequisite must throw")
    } catch {
      XCTAssertNil(host.view.window)
    }
  }

  func testReadyPrerequisiteCanContinueWithoutWaiting() async throws {
    try await eventually(timeout: .zero) { true }
  }
}
