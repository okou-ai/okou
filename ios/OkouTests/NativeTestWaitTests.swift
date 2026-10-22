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

  func testReadyPrerequisiteCanContinueWithoutWaiting() async throws {
    try await eventually(timeout: .zero) { true }
  }
}
