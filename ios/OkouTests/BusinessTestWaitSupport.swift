import Darwin
import Foundation
import Observation
import XCTest

@MainActor
extension XCTestCase {
  func waitForBusinessResult(
    timeout: TimeInterval = 3, file: StaticString = #filePath, line: UInt = #line,
    message: @autoclosure () -> String = "",
    _ predicate: @escaping @MainActor () -> Bool
  ) async throws {
    // A committed result does not need another actor turn or an observation deadline.
    if predicate() { return }
    let started = ContinuousClock.now
    var observed: Duration?
    let ready = expectation(
      description: "The production business result became available at \(file):\(line)")
    let observation = Task {
      for await result in Observations({ predicate() }) {
        if result {
          observed = started.duration(to: .now)
          ready.fulfill()
          return
        }
      }
    }
    let result = await XCTWaiter.fulfillment(of: [ready], timeout: timeout)
    let resumed = started.duration(to: .now)
    observation.cancel()
    await observation.value
    let joined = started.duration(to: .now)
    _ = try XCTUnwrap(
      result == .completed && predicate() ? true : nil,
      message() + "; business waiter=\(result); observed=\(String(describing: observed)); "
        + "resumed=\(resumed); joined=\(joined)",
      file: file, line: line)
  }

  func waitForFileRemoval(
    at url: URL, file: StaticString = #filePath, line: UInt = #line,
    removing: @MainActor () -> Void
  ) async throws {
    let descriptor = Darwin.open(url.path, O_EVTONLY)
    guard descriptor >= 0 else {
      XCTFail("Cannot observe the owned file before removal: \(url.path)", file: file, line: line)
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    let removed = expectation(description: "The owned file was removed")
    let stopped = expectation(description: "The file observer released its descriptor")
    let source = DispatchSource.makeFileSystemObjectSource(
      fileDescriptor: descriptor, eventMask: .delete, queue: .main)
    source.setEventHandler { removed.fulfill() }
    source.setCancelHandler {
      _ = Darwin.close(descriptor)
      stopped.fulfill()
    }
    source.activate()
    defer { source.cancel() }
    removing()
    await fulfillment(of: [removed], timeout: 3)
    source.cancel()
    await fulfillment(of: [stopped], timeout: 3)
    XCTAssertFalse(FileManager.default.fileExists(atPath: url.path), file: file, line: line)
  }
}
