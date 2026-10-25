import ChatData
import ChatDataTestSupport
import ChatDomain
import Foundation
import Synchronization
import UIKit
import XCTest

@testable import Okou

@MainActor
final class MessageAttachmentThumbnailTests: XCTestCase {
  func testCancelledCellKeepsSharedThumbnailAvailableWithoutFurtherNetworkRequests() async throws {
    let bytes = imageData()
    let transfers = Mutex(0)
    let server = try ChatFileHTTPServer { _ in
      transfers.withLock { $0 += 1 }
      return .init(body: bytes)
    }
    defer { server.stop() }
    let origin = try await server.start()
    let entered = expectation(description: "Thumbnail authorization started")
    let (gate, release) = AsyncStream<Void>.makeStream()
    defer { release.finish() }
    let lookups = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      XCTAssertEqual(request.url?.path, "/api/web/file-url")
      let count = lookups.withLock {
        $0 += 1
        return $0
      }
      guard count == 1 else {
        return ChatHTTPResponse(status: 503, body: "{\"error\":{\"message\":\"Offline\"}}")
      }
      entered.fulfill()
      for await _ in gate { break }
      return ChatHTTPResponse(
        body: "{\"url\":\"\(origin)/image\",\"downloadUrl\":\"\(origin)/image\"}")
    }
    let viewer = makeViewer(fixture)
    defer { viewer.close() }
    let image = ChatMessageAttachment(id: "image", filename: "image.png", contentType: "image/png")
    let first = Task { _ = try await viewer.thumbnail(image) }
    addTeardownBlock {
      first.cancel()
      release.finish()
      _ = await first.result
    }
    await fulfillment(of: [entered], timeout: 3)
    first.cancel()
    let second = Task {
      release.yield(())
      let thumbnail = try await viewer.thumbnail(image)
      XCTAssertNotNil(thumbnail)
    }
    addTeardownBlock {
      second.cancel()
      release.finish()
      _ = await second.result
    }
    try await second.value
    do {
      try await first.value
      XCTFail("The disappearing cell must not receive the shared result")
    } catch { XCTAssertTrue(error is CancellationError) }

    for _ in 0..<10 {
      let thumbnail = try await viewer.thumbnail(image)
      XCTAssertNotNil(thumbnail)
    }
    XCTAssertEqual(lookups.withLock { $0 }, 1)
    XCTAssertEqual(transfers.withLock { $0 }, 1)
  }

  func testDetailExitDiscardsLoadedThumbnailsAndCancelsPendingThumbnails() async throws {
    let bytes = imageData()
    let server = try ChatFileHTTPServer { _ in .init(body: bytes) }
    defer { server.stop() }
    let origin = try await server.start()
    let entered = expectation(description: "Second thumbnail authorization started")
    let (gate, release) = AsyncStream<Void>.makeStream()
    defer { release.finish() }
    let denied = Mutex(false)
    let fixture = ChatHTTPFixture { request in
      if denied.withLock({ $0 }) {
        return ChatHTTPResponse(status: 403, body: "{\"error\":{\"message\":\"Forbidden\"}}")
      }
      let id = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
        .queryItems?.first?.value
      if id == "pending" {
        entered.fulfill()
        for await _ in gate { break }
      }
      return ChatHTTPResponse(
        body: "{\"url\":\"\(origin)/image\",\"downloadUrl\":\"\(origin)/image\"}")
    }
    let viewer = makeViewer(fixture)
    defer { viewer.close() }
    let loaded = ChatMessageAttachment(
      id: "loaded", filename: "image.png", contentType: "image/png")
    let thumbnail = try await viewer.thumbnail(loaded)
    XCTAssertNotNil(thumbnail)
    let pending = ChatMessageAttachment(
      id: "pending", filename: "image.png", contentType: "image/png")
    let downloading = Task { _ = try await viewer.thumbnail(pending) }
    addTeardownBlock {
      downloading.cancel()
      release.finish()
      _ = await downloading.result
    }
    await fulfillment(of: [entered], timeout: 3)
    viewer.deactivate()
    denied.withLock { $0 = true }
    release.finish()
    do {
      try await downloading.value
      XCTFail("The previous detail must not publish its thumbnail")
    } catch {
      XCTAssertTrue(error is CancellationError || (error as? URLError)?.code == .cancelled)
    }
    for attachment in [loaded, pending] {
      do {
        _ = try await viewer.thumbnail(attachment)
        XCTFail("Reentering the detail must require fresh authorization")
      } catch { XCTAssertEqual((error as? APIClientError)?.statusCode, 403) }
    }
  }

  func testFailedThumbnailCanRetryAndRenderedFileNeedsItsOwnAuthorization() async throws {
    let bytes = imageData()
    let server = try ChatFileHTTPServer { _ in .init(body: bytes) }
    defer { server.stop() }
    let origin = try await server.start()
    let unavailable = Mutex(true)
    let fixture = ChatHTTPFixture { request in
      let id = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
        .queryItems?.first?.value
      if id == "annotated" {
        return ChatHTTPResponse(status: 403, body: "{\"error\":{\"message\":\"Forbidden\"}}")
      }
      if unavailable.withLock({ $0 }) {
        return ChatHTTPResponse(status: 503, body: "{\"error\":{\"message\":\"Unavailable\"}}")
      }
      return ChatHTTPResponse(
        body: "{\"url\":\"\(origin)/image\",\"downloadUrl\":\"\(origin)/image\"}")
    }
    let viewer = makeViewer(fixture)
    defer { viewer.close() }
    let image = ChatMessageAttachment(id: "image", filename: "image.png", contentType: "image/png")
    do {
      _ = try await viewer.thumbnail(image)
      XCTFail("An unavailable thumbnail must report its error")
    } catch { XCTAssertEqual((error as? APIClientError)?.statusCode, 503) }
    unavailable.withLock { $0 = false }
    let thumbnail = try await viewer.thumbnail(image)
    XCTAssertNotNil(thumbnail)
    let annotated = ChatMessageAttachment(
      id: "image", filename: "image.png", contentType: "image/png", renderedFileID: "annotated")
    do {
      _ = try await viewer.thumbnail(annotated)
      XCTFail("An annotated file must not reuse the original file's authorization")
    } catch { XCTAssertEqual((error as? APIClientError)?.statusCode, 403) }
  }

  private func makeViewer(_ fixture: ChatHTTPFixture) -> MessageAttachmentStore {
    MessageAttachmentStore(
      commands: ChatCommands(client: fixture.client, sync: ChatSync(client: fixture.client)),
      didFail: { _ in })
  }

  private func imageData() -> Data {
    UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8)).pngData { context in
      UIColor.systemTeal.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
    }
  }
}
