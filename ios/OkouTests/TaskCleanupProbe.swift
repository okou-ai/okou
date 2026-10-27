import Synchronization
import XCTest

/// Temporary fault injection; removed before the final business-suite run.
final class TaskCleanupProbe: Sendable {
  private let id: String
  private let cancellation = AsyncStream<Void>.makeStream()
  private let completed = Mutex(false)

  init(id: String) { self.id = id }

  var hasFinished: Bool { completed.withLock { $0 } }

  func waitForCancellation() async {
    for await _ in cancellation.stream {}
    completed.withLock { $0 = true }
  }

  func exit() throws { throw ExpectedExit(id: id) }

  func reportJoin(_ joined: Bool, file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertTrue(joined, "A01_PROBE_TASK_NOT_JOINED:\(id)", file: file, line: line)
    if joined { print("A01_PROBE_TASK_JOINED:\(id)") }
  }

  private struct ExpectedExit: Error, CustomStringConvertible {
    let id: String
    var description: String { "A01_EXPECTED_EXIT:\(id)" }
  }
}
