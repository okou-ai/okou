import ChatDataTestSupport
import Foundation
import Synchronization
import UIKit
import XCTest

@testable import Okou

@MainActor
final class ConnectorIconResourcesTests: XCTestCase {
  func testDetachedConsumerKeepsSharedIconAvailableWithoutAnotherDownload() async throws {
    let bytes = png(side: 8)
    let downloads = Mutex(0)
    let entered = expectation(description: "Icon download started")
    let gate = AsyncStream<Void>.makeStream()
    defer { gate.continuation.finish() }
    let server = try ChatFileHTTPServer { _ in
      let first = downloads.withLock {
        $0 += 1
        return $0 == 1
      }
      guard first else { return .init(status: 503) }
      entered.fulfill()
      for await _ in gate.stream { break }
      return .init(
        headers: ["Content-Type": "image/png", "Cache-Control": "no-store"], body: bytes)
    }
    addTeardownBlock { await server.stop() }
    let origin = try await server.start()
    let resources = try makeResources()
    let read = resources.icon(origin.appending(path: "shared.png"))
    let subscription = try resources.store.watch(read.value) {}
    addTeardownBlock { @MainActor in try subscription.cancel() }
    let first = try own(resources.store.get(read.value))
    await fulfillment(of: [entered], timeout: 3)
    try subscription.cancel()
    let second = try own(resources.store.get(read.value))
    gate.continuation.yield(())
    let firstImage = try await first.value
    let secondImage = try await second.value
    XCTAssertEqual(firstImage.size, CGSize(width: 8, height: 8))
    XCTAssertEqual(secondImage.size, firstImage.size)
    let cached = try await resources.store.get(read.value).value
    XCTAssertEqual(cached.size, firstImage.size)
    XCTAssertEqual(downloads.withLock { $0 }, 1)
  }

  func testFailedIconStaysFailedUntilExplicitRetryRecoversTheSameResource() async throws {
    let bytes = png(side: 8)
    let unavailable = Mutex(true)
    let downloads = Mutex(0)
    let server = try ChatFileHTTPServer { _ in
      downloads.withLock { $0 += 1 }
      if unavailable.withLock({ $0 }) { return .init(status: 503) }
      return .init(
        headers: ["Content-Type": "image/png", "Cache-Control": "no-store"], body: bytes)
    }
    addTeardownBlock { await server.stop() }
    let origin = try await server.start()
    let resources = try makeResources()
    let read = resources.icon(origin.appending(path: "retry.png"))
    do {
      _ = try await resources.store.get(read.value).value
      XCTFail("An unavailable icon must retain its failed read")
    } catch { XCTAssertEqual((error as? URLError)?.code, .badServerResponse) }
    unavailable.withLock { $0 = false }
    do {
      _ = try await resources.store.get(read.value).value
      XCTFail("Observing a failed read must not start another download")
    } catch { XCTAssertEqual((error as? URLError)?.code, .badServerResponse) }
    XCTAssertEqual(downloads.withLock { $0 }, 1)
    resources.retryIfNeeded(read)
    let recovered = try await resources.store.get(read.value).value
    XCTAssertEqual(recovered.size, CGSize(width: 8, height: 8))
    XCTAssertEqual(downloads.withLock { $0 }, 2)
  }

  func testClosingOwnerCancelsPendingDownloadAndRetiresItsRead() async throws {
    let bytes = png(side: 8)
    let entered = expectation(description: "Pending icon download started")
    let gate = AsyncStream<Void>.makeStream()
    defer { gate.continuation.finish() }
    let server = try ChatFileHTTPServer { _ in
      entered.fulfill()
      for await _ in gate.stream { break }
      return .init(
        headers: ["Content-Type": "image/png", "Cache-Control": "no-store"], body: bytes)
    }
    addTeardownBlock { await server.stop() }
    let origin = try await server.start()
    let resources = try makeResources()
    let read = resources.icon(origin.appending(path: "pending.png"))
    let request = try own(resources.store.get(read.value))
    await fulfillment(of: [entered], timeout: 3)
    try resources.close()
    gate.continuation.finish()
    do {
      _ = try await request.value
      XCTFail("A closed owner must cancel its original download")
    } catch {
      XCTAssertTrue(error is CancellationError || (error as? URLError)?.code == .cancelled)
    }
    do {
      _ = try await resources.store.get(read.value).value
      XCTFail("A retired resource must not return an image")
    } catch { XCTAssertTrue(error is CancellationError) }
  }

  func testDiskCacheSuppliesAnIconToANewOwnerWithoutDownloadingItAgain() async throws {
    let bytes = png(side: 8)
    let downloads = Mutex(0)
    let server = try ChatFileHTTPServer { _ in
      let first = downloads.withLock {
        $0 += 1
        return $0 == 1
      }
      guard first else { return .init(status: 503) }
      return .init(
        headers: ["Content-Type": "image/png", "Cache-Control": "no-store"], body: bytes)
    }
    addTeardownBlock { await server.stop() }
    let origin = try await server.start()
    let directory = try cacheDirectory()
    let first = makeResources(directory: directory)
    let url = origin.appending(path: "persisted.png")
    let loaded = try await first.store.get(first.icon(url).value).value
    XCTAssertEqual(loaded.size, CGSize(width: 8, height: 8))
    try first.close()
    let second = makeResources(directory: directory)
    let reopened = try await second.store.get(second.icon(url).value).value
    XCTAssertEqual(reopened.size, loaded.size)
    XCTAssertEqual(downloads.withLock { $0 }, 1)
  }

  func testDifferentURLLoadsIndependentlyAndKeepsItsImageAfterAnOlderReadFinishes() async throws {
    let oldBytes = png(side: 8)
    let newBytes = png(side: 12)
    let entered = expectation(description: "Old icon download started")
    let gate = AsyncStream<Void>.makeStream()
    defer { gate.continuation.finish() }
    let server = try ChatFileHTTPServer { request in
      if request.url?.lastPathComponent == "old.png" {
        entered.fulfill()
        for await _ in gate.stream { break }
        return .init(
          headers: ["Content-Type": "image/png", "Cache-Control": "no-store"], body: oldBytes)
      }
      return .init(
        headers: ["Content-Type": "image/png", "Cache-Control": "no-store"], body: newBytes)
    }
    addTeardownBlock { await server.stop() }
    let origin = try await server.start()
    let resources = try makeResources()
    let oldRead = resources.icon(origin.appending(path: "old.png"))
    let old = try own(resources.store.get(oldRead.value))
    await fulfillment(of: [entered], timeout: 3)
    let current = resources.icon(origin.appending(path: "new.png"))
    let image = try await resources.store.get(current.value).value
    XCTAssertEqual(image.size, CGSize(width: 12, height: 12))
    gate.continuation.yield(())
    let previous = try await old.value
    XCTAssertEqual(previous.size, CGSize(width: 8, height: 8))
    let stillCurrent = try await resources.store.get(current.value).value
    XCTAssertEqual(stillCurrent.size, image.size)
  }

  private func png(side: Int) -> Data {
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    let side = CGFloat(side)
    let renderer = UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format)
    return renderer.pngData { context in
      UIColor.systemTeal.setFill()
      context.fill(CGRect(x: 0, y: 0, width: side, height: side))
    }
  }

  private func cacheDirectory() throws -> URL {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    addTeardownBlock { try FileManager.default.removeItem(at: directory) }
    return directory
  }

  private func makeResources() throws -> ConnectorIconResources {
    makeResources(directory: try cacheDirectory())
  }

  private func makeResources(directory: URL) -> ConnectorIconResources {
    let resources = ConnectorIconResources(loader: ConnectorIconLoader(cacheDirectory: directory))
    addTeardownBlock { @MainActor in try resources.close() }
    return resources
  }

  private func own(_ task: Task<UIImage, Error>) -> Task<UIImage, Error> {
    addTeardownBlock {
      task.cancel()
      _ = await task.result
    }
    return task
  }
}
