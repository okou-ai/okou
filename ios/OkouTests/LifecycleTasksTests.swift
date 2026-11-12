import Foundation
import XCTest

@testable import Okou

@MainActor
final class LifecycleTasksTests: XCTestCase {
  func testShutdownJoinsCancelledWorkAfterItsActionHandleIsReplaced() async {
    let tasks = LifecycleTasks()
    let gate = LifecycleCleanupGate()
    let started = expectation(description: "Original operation owns its cleanup gate")
    var cleaned = false
    let original = Task {
      started.fulfill()
      await gate.wait()
      cleaned = true
    }
    tasks.track(original)
    addTeardownBlock { @MainActor in
      gate.open()
      await tasks.close().value
    }
    await fulfillment(of: [started], timeout: 3)
    original.cancel()
    let replacement = Task { "replacement" }
    tasks.track(replacement)
    let value = await replacement.value
    XCTAssertEqual(value, "replacement")

    let completion = tasks.close()
    gate.open()
    await completion.value

    XCTAssertTrue(cleaned)
  }

  func testShutdownCancelsOriginalWorkAndWaitsForRetiringChildren() async {
    let tasks = LifecycleTasks()
    let child = LifecycleTasks()
    let gate = LifecycleCleanupGate()
    let started = expectation(description: "Child operation started")
    var cleaned = false
    let operation = Task {
      started.fulfill()
      await gate.wait()
      cleaned = true
    }
    child.track(operation)
    addTeardownBlock { @MainActor in
      gate.open()
      await tasks.close(after: [child.close()]).value
    }
    await fulfillment(of: [started], timeout: 3)

    tasks.track(child.close())
    let completion = tasks.close()
    XCTAssertTrue(operation.isCancelled)
    gate.open()
    await completion.value

    XCTAssertTrue(cleaned)
  }
}

/// Model cleanup that must finish even after cancellation, without a real-time delay.
@MainActor
private final class LifecycleCleanupGate {
  private var continuation: CheckedContinuation<Void, Never>?
  private var opened = false

  func wait() async {
    guard !opened else { return }
    await withCheckedContinuation { continuation = $0 }
  }

  func open() {
    opened = true
    continuation?.resume()
    continuation = nil
  }
}
