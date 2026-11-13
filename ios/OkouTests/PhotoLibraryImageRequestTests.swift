import Foundation
import Photos
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class PhotoLibraryImageRequestTests: XCTestCase {
  func testCancellationStopsTheOriginalRequestAndFinishesBeforeItsLateReply() async throws {
    let began = expectation(description: "PhotoKit accepted the request")
    let cancelled = expectation(description: "The original PhotoKit request was cancelled")
    let completion = Mutex<(@Sendable (Result<Data, Error>) -> Void)?>(nil)
    let task = Task {
      try await PhotoLibraryImageRequest<Data>.read(
        start: { reply in
          completion.withLock { $0 = reply }
          began.fulfill()
          return 73
        },
        cancel: { id in
          XCTAssertEqual(id, 73)
          cancelled.fulfill()
        })
    }
    addTeardownBlock {
      task.cancel()
      _ = await task.result
    }
    await fulfillment(of: [began], timeout: 3)
    task.cancel()
    await fulfillment(of: [cancelled], timeout: 3)
    do {
      _ = try await task.value
      XCTFail("The caller must finish as cancelled before PhotoKit replies")
    } catch {
      XCTAssertTrue(error is CancellationError)
    }
    let reply = try XCTUnwrap(completion.withLock { $0 })
    reply(.success(Data("late photo".utf8)))
    reply(.failure(CocoaError(.userCancelled)))
  }

  func testCancellationDuringAcquisitionCancelsTheIdentifierReturnedAfterward() async {
    let cancelled = expectation(description: "The newly returned request ID was cancelled")
    let task = Task {
      try await PhotoLibraryImageRequest<Data>.read(
        start: { _ in
          // Model the caller cancelling while PhotoKit has not yet returned its ID.
          withUnsafeCurrentTask { $0?.cancel() }
          return 81
        },
        cancel: { id in
          XCTAssertEqual(id, 81)
          cancelled.fulfill()
        })
    }
    addTeardownBlock {
      task.cancel()
      _ = await task.result
    }
    do {
      _ = try await task.value
      XCTFail("Cancellation during request acquisition must reach the caller")
    } catch {
      XCTAssertTrue(error is CancellationError)
    }
    await fulfillment(of: [cancelled], timeout: 3)
  }

  func testAnAlreadyCancelledCallerDoesNotStartAnotherPhotoRead() async {
    let task = Task {
      withUnsafeCurrentTask { $0?.cancel() }
      return try await PhotoLibraryImageRequest<Data>.read(
        start: { _ in
          XCTFail("An already cancelled caller must not acquire PhotoKit work")
          return 91
        },
        cancel: { _ in XCTFail("No PhotoKit request was acquired") })
    }
    addTeardownBlock {
      task.cancel()
      _ = await task.result
    }
    do {
      _ = try await task.value
      XCTFail("The caller must observe cancellation")
    } catch {
      XCTAssertTrue(error is CancellationError)
    }
  }

  func testSynchronousPhotoDeliveryKeepsItsBytesAndIgnoresARepeatedCallback() async throws {
    let data = Data("original photo bytes".utf8)
    let completion = Mutex<(@Sendable (Result<Data, Error>) -> Void)?>(nil)
    let result = try await PhotoLibraryImageRequest<Data>.read(
      start: { reply in
        completion.withLock { $0 = reply }
        reply(.success(data))
        return 101
      },
      cancel: { _ in XCTFail("A completed request must not cancel a potentially reused SDK ID") })
    XCTAssertEqual(result, data)
    let reply = try XCTUnwrap(completion.withLock { $0 })
    reply(.failure(CocoaError(.fileReadUnknown)))
  }
}
