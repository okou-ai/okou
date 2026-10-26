import Foundation
import Observation
import XCTest

@MainActor
extension XCTestCase {
  func waitForBusinessResult(
    timeout: TimeInterval = 3, file: StaticString = #filePath, line: UInt = #line,
    _ predicate: @escaping @MainActor () -> Bool
  ) async throws {
    let ready = expectation(description: "The production business result became available")
    let observation = Task {
      for await result in Observations({ predicate() }) {
        if result {
          ready.fulfill()
          return
        }
      }
    }
    await fulfillment(of: [ready], timeout: timeout)
    observation.cancel()
    await observation.value
    _ = try XCTUnwrap(predicate() ? true : nil, file: file, line: line)
  }
}
