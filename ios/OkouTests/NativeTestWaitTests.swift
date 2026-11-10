import SwiftUI
import Synchronization
import XCTest

@MainActor
final class NativeTestWaitTests: XCTestCase {
  func testLateBusinessResultCannotContinueAfterTheWaiterTimesOut() async {
    let message = "A business result arriving after timeout cannot satisfy the wait"
    let lateResult = Mutex(false)
    XCTExpectFailure(
      "Verify that a missed business deadline stops dependent actions",
      issueMatcher: { @Sendable issue in
        let description = issue.compactDescription
        guard description.contains(message)
          || (description.contains("Exceeded timeout")
            && description.contains("NativeTestWaitTests.swift"))
        else { return false }
        // Deliver the result only after XCTest has recorded the missed deadline.
        lateResult.withLock { $0 = true }
        return true
      })
    var reachedDependentAction = false
    var caughtFailure = false
    do {
      try await waitForBusinessResult(timeout: 0, message: message) {
        lateResult.withLock { $0 }
      }
      reachedDependentAction = true
    } catch {
      caughtFailure = true
    }
    XCTAssertTrue(lateResult.withLock { $0 })
    XCTAssertTrue(caughtFailure)
    XCTAssertFalse(reachedDependentAction)
  }

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

  func testNativeReadinessCanCompleteWithoutMountingAWindow() async throws {
    let view = UIView()
    DispatchQueue.main.async { view.accessibilityIdentifier = "Ready" }
    try await eventually { view.accessibilityIdentifier == "Ready" }
    XCTAssertNil(view.window)
  }
}
