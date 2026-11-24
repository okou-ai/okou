import CCState
import Darwin
import Foundation
import Observation
import XCTest

@testable import Okou

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
      for await result in Observations({ predicate() }) where result {
        observed = started.duration(to: .now)
        ready.fulfill()
        return
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

  /// Waits for a predicate over graph-owned state. It is checked again whenever the watched
  /// signal changes, and whenever an Observation-tracked value it reads changes.
  func waitForBusinessResult<Value>(
    watching signal: Signal<Value>, in store: CCState.Store,
    timeout: TimeInterval = 3, file: StaticString = #filePath, line: UInt = #line,
    message: @autoclosure () -> String = "",
    _ predicate: @escaping @MainActor () -> Bool
  ) async throws {
    if predicate() { return }
    let started = ContinuousClock.now
    var observed: Duration?
    let ready = expectation(
      description: "The production business result became available at \(file):\(line)")
    let check: @MainActor () -> Void = {
      guard observed == nil, predicate() else { return }
      observed = started.duration(to: .now)
      ready.fulfill()
    }
    let subscription = try store.watch(signal) { check() }
    defer {
      do { try subscription.cancel() } catch { XCTFail("Graph waiter cleanup: \(error)") }
    }
    let observation = Task {
      for await result in Observations({ predicate() }) where result {
        check()
        return
      }
    }
    // A change committed before the listener was mounted is not replayed to it.
    check()
    let result = await XCTWaiter.fulfillment(of: [ready], timeout: timeout)
    let resumed = started.duration(to: .now)
    observation.cancel()
    await observation.value
    _ = try XCTUnwrap(
      result == .completed && predicate() ? true : nil,
      message() + "; graph waiter=\(result); observed=\(String(describing: observed)); "
        + "resumed=\(resumed)",
      file: file, line: line)
  }

  /// Waits for a predicate over a composer's draft, upload, voice phase or synchronization state.
  func waitForBusinessResult(
    watching composer: ComposerDraftStore,
    timeout: TimeInterval = 3, file: StaticString = #filePath, line: UInt = #line,
    message: @autoclosure () -> String = "",
    _ predicate: @escaping @MainActor () -> Bool
  ) async throws {
    try await waitForBusinessResult(
      watching: composer.presentation, in: composer.store, timeout: timeout, file: file,
      line: line, message: message(), predicate)
  }

  /// Waits for a predicate over a conversation's graph state: its transcript (confirmed
  /// history, pending messages, streamed output and their items) and its composer's draft.
  /// It is checked again whenever either value changes, and whenever an Observation-tracked
  /// value it reads changes.
  func waitForBusinessResult(
    watching conversation: ConversationStore,
    timeout: TimeInterval = 3, file: StaticString = #filePath, line: UInt = #line,
    message: @autoclosure () -> String = "",
    _ predicate: @escaping @MainActor () -> Bool
  ) async throws {
    if predicate() { return }
    let started = ContinuousClock.now
    var observed: Duration?
    let ready = expectation(
      description: "The production business result became available at \(file):\(line)")
    let check: @MainActor () -> Void = {
      guard observed == nil, predicate() else { return }
      observed = started.duration(to: .now)
      ready.fulfill()
    }
    let store = conversation.graph
    let transcript = try store.watch(conversation.transcript) { check() }
    defer {
      do { try transcript.cancel() } catch { XCTFail("Transcript waiter cleanup: \(error)") }
    }
    let draft = try store.watch(conversation.composer.presentation) { check() }
    defer {
      do { try draft.cancel() } catch { XCTFail("Draft waiter cleanup: \(error)") }
    }
    let observation = Task {
      for await result in Observations({ predicate() }) where result {
        check()
        return
      }
    }
    // A change committed before the listeners were mounted is not replayed to them.
    check()
    let result = await XCTWaiter.fulfillment(of: [ready], timeout: timeout)
    let resumed = started.duration(to: .now)
    observation.cancel()
    await observation.value
    _ = try XCTUnwrap(
      result == .completed && predicate() ? true : nil,
      message() + "; conversation waiter=\(result); observed=\(String(describing: observed)); "
        + "resumed=\(resumed)",
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
