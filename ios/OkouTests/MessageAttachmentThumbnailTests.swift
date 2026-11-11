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
    addTeardownBlock { await server.stop() }
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
    let resources = viewer.reads
    let read = resources.thumbnail(image)
    let subscription = try resources.store.watch(read.value) {}
    addTeardownBlock { @MainActor in try subscription.cancel() }
    let first = Task { _ = try await resources.store.get(read.value).value }
    addTeardownBlock {
      first.cancel()
      release.finish()
      _ = await first.result
    }
    await fulfillment(of: [entered], timeout: 3)
    first.cancel()
    try subscription.cancel()
    let second = Task {
      release.yield(())
      let thumbnail = try await resources.store.get(read.value).value
      XCTAssertNotNil(thumbnail.image)
    }
    addTeardownBlock {
      second.cancel()
      release.finish()
      _ = await second.result
    }
    try await second.value
    _ = try await first.value

    for _ in 0..<10 {
      let thumbnail = try await readThumbnail(image, viewer: viewer)
      XCTAssertNotNil(thumbnail)
    }
    XCTAssertEqual(lookups.withLock { $0 }, 1)
    XCTAssertEqual(transfers.withLock { $0 }, 1)
  }

  func testDetailExitDiscardsLoadedThumbnailsAndCancelsPendingThumbnails() async throws {
    let bytes = imageData()
    let server = try ChatFileHTTPServer { _ in .init(body: bytes) }
    addTeardownBlock { await server.stop() }
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
    let thumbnail = try await readThumbnail(loaded, viewer: viewer)
    XCTAssertNotNil(thumbnail)
    let pending = ChatMessageAttachment(
      id: "pending", filename: "image.png", contentType: "image/png")
    let downloading = Task { _ = try await readThumbnail(pending, viewer: viewer) }
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
        _ = try await readThumbnail(attachment, viewer: viewer)
        XCTFail("Reentering the detail must require fresh authorization")
      } catch { XCTAssertEqual((error as? APIClientError)?.statusCode, 403) }
    }
  }

  func testFailedThumbnailCanRetryAndRenderedFileNeedsItsOwnAuthorization() async throws {
    let bytes = imageData()
    let server = try ChatFileHTTPServer { _ in .init(body: bytes) }
    addTeardownBlock { await server.stop() }
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
      _ = try await readThumbnail(image, viewer: viewer)
      XCTFail("An unavailable thumbnail must report its error")
    } catch { XCTAssertEqual((error as? APIClientError)?.statusCode, 503) }
    unavailable.withLock { $0 = false }
    let thumbnail = try await readThumbnail(image, viewer: viewer)
    XCTAssertNotNil(thumbnail)
    let annotated = ChatMessageAttachment(
      id: "image", filename: "image.png", contentType: "image/png", renderedFileID: "annotated")
    do {
      _ = try await readThumbnail(annotated, viewer: viewer)
      XCTFail("An annotated file must not reuse the original file's authorization")
    } catch { XCTAssertEqual((error as? APIClientError)?.statusCode, 403) }
  }

  func testLoadedImageOpensAndReopensWithoutRetransferringOriginalBytes() async throws {
    let bytes = imageData()
    let transfers = Mutex(0)
    let server = try ChatFileHTTPServer { _ in
      transfers.withLock { $0 += 1 }
      return .init(body: bytes)
    }
    addTeardownBlock { await server.stop() }
    let origin = try await server.start()
    let lookups = Mutex(0)
    let fixture = ChatHTTPFixture { _ in
      lookups.withLock { $0 += 1 }
      return ChatHTTPResponse(
        body: "{\"url\":\"\(origin)/image\",\"downloadUrl\":\"\(origin)/download\"}")
    }
    let viewer = makeViewer(fixture)
    defer { viewer.close() }
    let image = ChatMessageAttachment(id: "image", filename: "image.png", contentType: "image/png")
    let thumbnail = try await readThumbnail(image, viewer: viewer)
    XCTAssertNotNil(thumbnail)
    viewer.open(image)
    let url = try await previewFile(in: viewer).url
    XCTAssertEqual(try Data(contentsOf: url), bytes)
    viewer.dismiss()
    viewer.open(image)
    let reopened = try await previewFile(in: viewer).url
    XCTAssertEqual(try Data(contentsOf: reopened), bytes)
    XCTAssertEqual(lookups.withLock { $0 }, 3)
    XCTAssertEqual(transfers.withLock { $0 }, 1)
    viewer.deactivate()
    XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
    let thumbnailAfterReentry = try await readThumbnail(image, viewer: viewer)
    XCTAssertNotNil(thumbnailAfterReentry)
    XCTAssertEqual(transfers.withLock { $0 }, 1)
  }

  func testSeparateThumbnailStaysAvailableWhileOpeningTheFullOriginal() async throws {
    let poster = imageData()
    let original = imageData(color: .systemOrange)
    let paths = Mutex<[String]>([])
    let server = try ChatFileHTTPServer { request in
      let path = request.url!.path
      paths.withLock { $0.append(path) }
      return .init(body: path == "/poster" ? poster : original)
    }
    addTeardownBlock { await server.stop() }
    let origin = try await server.start()
    let fixture = ChatHTTPFixture { _ in
      ChatHTTPResponse(
        body:
          "{\"url\":\"\(origin)/image\",\"downloadUrl\":\"\(origin)/download\",\"previewImageUrl\":\"\(origin)/poster\"}"
      )
    }
    let viewer = makeViewer(fixture)
    defer { viewer.close() }
    let image = ChatMessageAttachment(id: "image", filename: "image.png", contentType: "image/png")
    let thumbnail = try await readThumbnail(image, viewer: viewer)
    XCTAssertNotNil(thumbnail)
    viewer.open(image)
    XCTAssertNotNil(viewer.preview?.thumbnail)
    let url = try await previewFile(in: viewer).url
    XCTAssertEqual(try Data(contentsOf: url), original)
    XCTAssertEqual(paths.withLock { $0 }, ["/poster", "/download"])
  }

  func testCachedOriginalCannotBeOpenedAfterAccessIsRevoked() async throws {
    let bytes = imageData()
    let server = try ChatFileHTTPServer { _ in .init(body: bytes) }
    addTeardownBlock { await server.stop() }
    let origin = try await server.start()
    let denied = Mutex(false)
    let fixture = ChatHTTPFixture { _ in
      if denied.withLock({ $0 }) {
        return ChatHTTPResponse(status: 403, body: "{\"error\":{\"message\":\"Forbidden\"}}")
      }
      return ChatHTTPResponse(
        body: "{\"url\":\"\(origin)/image\",\"downloadUrl\":\"\(origin)/download\"}")
    }
    let viewer = makeViewer(fixture)
    defer { viewer.close() }
    let image = ChatMessageAttachment(id: "image", filename: "image.png", contentType: "image/png")
    let thumbnail = try await readThumbnail(image, viewer: viewer)
    XCTAssertNotNil(thumbnail)
    denied.withLock { $0 = true }
    viewer.open(image)
    let preview = try XCTUnwrap(viewer.preview)
    do {
      _ = try await preview.store.get(preview.file).value
      XCTFail("A cached original must not bypass revoked authorization")
    } catch {
      XCTAssertEqual((error as? APIClientError)?.statusCode, 403)
      XCTAssertEqual(
        MessageAttachmentStore.message(for: error),
        "You do not have permission to view this attachment.")
      XCTAssertFalse(ChatRequestFailure.canRetry(error))
    }
  }

  func testSharedThumbnailFailureCanRetryWithoutReplacingItsResource() async throws {
    let bytes = imageData()
    let server = try ChatFileHTTPServer { _ in .init(body: bytes) }
    addTeardownBlock { await server.stop() }
    let origin = try await server.start()
    let unavailable = Mutex(true)
    let lookups = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      guard request.httpMethod == "GET", let url = request.url, url.path == "/api/web/file-url",
        URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?
          .first(where: { $0.name == "file_id" })?.value == "image"
      else { throw URLError(.unsupportedURL) }
      lookups.withLock { $0 += 1 }
      if unavailable.withLock({ $0 }) {
        return ChatHTTPResponse(status: 503, body: "{\"error\":{\"message\":\"Offline\"}}")
      }
      return ChatHTTPResponse(
        body: "{\"url\":\"\(origin)/image\",\"downloadUrl\":\"\(origin)/image\"}")
    }
    let viewer = makeViewer(fixture)
    defer { viewer.close() }
    let image = ChatMessageAttachment(id: "image", filename: "image.png", contentType: "image/png")
    let resources = viewer.reads
    let read = resources.thumbnail(image)
    do {
      _ = try await resources.store.get(read.value).value
      XCTFail("An unavailable thumbnail must report its error")
    } catch { XCTAssertEqual((error as? APIClientError)?.statusCode, 503) }
    unavailable.withLock { $0 = false }
    do {
      _ = try await resources.store.get(read.value).value
      XCTFail("Observing the failed resource must not start another request")
    } catch { XCTAssertEqual((error as? APIClientError)?.statusCode, 503) }
    XCTAssertEqual(lookups.withLock { $0 }, 1)
    let retried = try await readThumbnail(image, viewer: viewer)
    XCTAssertNotNil(retried)
    let displayed = try await resources.store.get(read.value).value
    XCTAssertNotNil(displayed.image)
    XCTAssertEqual(lookups.withLock { $0 }, 2)
  }

  func testRetiredThumbnailResourceCannotReturnItsPreviousImage() async throws {
    let bytes = imageData()
    let server = try ChatFileHTTPServer { _ in .init(body: bytes) }
    addTeardownBlock { await server.stop() }
    let origin = try await server.start()
    let denied = Mutex(false)
    let fixture = ChatHTTPFixture { request in
      guard request.httpMethod == "GET", let url = request.url, url.path == "/api/web/file-url",
        URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?
          .first(where: { $0.name == "file_id" })?.value == "image"
      else { throw URLError(.unsupportedURL) }
      if denied.withLock({ $0 }) {
        return ChatHTTPResponse(status: 403, body: "{\"error\":{\"message\":\"Forbidden\"}}")
      }
      return ChatHTTPResponse(
        body: "{\"url\":\"\(origin)/image\",\"downloadUrl\":\"\(origin)/image\"}")
    }
    let viewer = makeViewer(fixture)
    defer { viewer.close() }
    let image = ChatMessageAttachment(id: "image", filename: "image.png", contentType: "image/png")
    let resources = viewer.reads
    let read = resources.thumbnail(image)
    let loaded = try await resources.store.get(read.value).value
    XCTAssertNotNil(loaded.image)
    viewer.deactivate()
    denied.withLock { $0 = true }
    do {
      _ = try await resources.store.get(read.value).value
      XCTFail("A retired detail must not return its cached thumbnail")
    } catch { XCTAssertTrue(error is CancellationError) }
    do {
      _ = try await readThumbnail(image, viewer: viewer)
      XCTFail("A replacement detail must obtain fresh authorization")
    } catch { XCTAssertEqual((error as? APIClientError)?.statusCode, 403) }
  }

  private func previewFile(in viewer: MessageAttachmentStore) async throws -> ChatAttachmentFile {
    let preview = try XCTUnwrap(viewer.preview)
    let result = try await preview.store.get(preview.file).value
    return try XCTUnwrap(result)
  }

  private func readThumbnail(_ attachment: ChatMessageAttachment, viewer: MessageAttachmentStore)
    async throws -> UIImage?
  {
    let reads = viewer.reads
    let read = reads.thumbnail(attachment)
    reads.retryIfNeeded(read)
    return try await reads.store.get(read.value).value.image
  }

  private func makeViewer(_ fixture: ChatHTTPFixture) -> MessageAttachmentStore {
    let commands = ChatCommands(client: fixture.client, sync: ChatSync(client: fixture.client))
    addTeardownBlock { commands.closeFileCache() }
    return MessageAttachmentStore(commands: commands, didFail: { _ in })
  }

  private func imageData(color: UIColor = .systemTeal) -> Data {
    UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8)).pngData { context in
      color.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
    }
  }
}
