import ChatData
import ChatDataTestSupport
import ChatDomain
import Foundation
import Synchronization
import XCTest

@MainActor
final class AttachmentDownloadTests: XCTestCase {
  private let attachment = ChatMessageAttachment(
    id: "private-file", filename: "../../report.pdf", contentType: "application/pdf")

  func testDownloadRefreshesExpiredSignatureAndKeepsCredentialsOnAPIWithScopedTemporaryFile()
    async throws
  {
    let server = try ChatFileHTTPServer { request in
      XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
      XCTAssertNil(request.value(forHTTPHeaderField: "X-Client-Type"))
      XCTAssertNil(request.value(forHTTPHeaderField: "X-Client-Session-Id"))
      XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
      return request.url?.path == "/expired"
        ? .init(status: 403) : .init(body: Data("%PDF-sample".utf8))
    }
    let origin = try await server.start()
    defer { server.stop() }
    let lookups = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      XCTAssertEqual(request.url?.path, "/api/web/file-url")
      XCTAssertEqual(
        URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first?.value,
        "private-file")
      XCTAssertEqual(
        request.value(forHTTPHeaderField: "Authorization"), "Bearer local-test-session")
      let count = lookups.withLock {
        $0 += 1
        return $0
      }
      let path = count == 1 ? "expired" : "current"
      return ChatHTTPResponse(
        body: "{\"url\":\"\(origin)/\(path)\",\"downloadUrl\":\"\(origin)/\(path)\"}")
    }
    let commands = ChatCommands(client: fixture.client, sync: ChatSync(client: fixture.client))
    var file = try await commands.downloadAttachment(attachment)
    let url = try XCTUnwrap(file?.url)
    XCTAssertEqual(try Data(contentsOf: url), Data("%PDF-sample".utf8))
    XCTAssertEqual(file?.size, 11)
    XCTAssertEqual(url.lastPathComponent, "report.pdf")
    XCTAssertEqual(lookups.withLock { $0 }, 2)
    file = nil
    XCTAssertFalse(FileManager.default.fileExists(atPath: url.deletingLastPathComponent().path))
  }

  func testAccessFailureDoesNotDownloadAndExplicitRetryReauthorizes() async throws {
    let denied = Mutex(true)
    let server = try ChatFileHTTPServer { _ in .init(body: Data("file".utf8)) }
    let origin = try await server.start()
    defer { server.stop() }
    let fixture = ChatHTTPFixture { _ in
      if denied.withLock({ $0 }) {
        return ChatHTTPResponse(status: 404, body: "{\"error\":{\"message\":\"File not found\"}}")
      }
      return ChatHTTPResponse(
        body: "{\"url\":\"\(origin)/file\",\"downloadUrl\":\"\(origin)/file\"}")
    }
    let commands = ChatCommands(client: fixture.client, sync: ChatSync(client: fixture.client))
    do {
      _ = try await commands.downloadAttachment(attachment)
      XCTFail("Unavailable files must fail")
    } catch { XCTAssertEqual((error as? APIClientError)?.statusCode, 404) }
    denied.withLock { $0 = false }
    let downloaded = try await commands.downloadAttachment(attachment)
    XCTAssertEqual(downloaded?.size, 4)
  }

  func testThumbnailUsesPosterAndRejectsInsecureStorageAddresses() async throws {
    let server = try ChatFileHTTPServer { request in
      XCTAssertEqual(request.url?.path, "/poster")
      return .init(body: Data("poster".utf8))
    }
    let origin = try await server.start()
    defer { server.stop() }
    let insecure = Mutex(false)
    let fixture = ChatHTTPFixture { _ in
      let url = insecure.withLock { $0 } ? "http://untrusted.example/file" : "\(origin)/poster"
      return ChatHTTPResponse(
        body:
          "{\"url\":\"\(origin)/original\",\"downloadUrl\":\"\(origin)/original\",\"previewImageUrl\":\"\(url)\"}"
      )
    }
    let commands = ChatCommands(client: fixture.client, sync: ChatSync(client: fixture.client))
    let poster = try await commands.downloadAttachment(attachment, thumbnail: true)
    XCTAssertEqual(poster?.size, 6)
    insecure.withLock { $0 = true }
    do {
      _ = try await commands.downloadAttachment(attachment, thumbnail: true)
      XCTFail("Reject cleartext storage")
    } catch { guard case APIClientError.invalidURL = error else { throw error } }
  }

  func testThumbnailTransferIsBoundedAndCancellationDoesNotReturnAFile() async throws {
    let server = try ChatFileHTTPServer { _ in
      .init(headers: ["Content-Length": "22000000"], body: Data(repeating: 42, count: 22_000_000))
    }
    let origin = try await server.start()
    defer { server.stop() }
    let fixture = ChatHTTPFixture { _ in
      ChatHTTPResponse(body: "{\"url\":\"\(origin)/image\",\"downloadUrl\":\"\(origin)/image\"}")
    }
    let commands = ChatCommands(client: fixture.client, sync: ChatSync(client: fixture.client))
    let image = ChatMessageAttachment(id: "image", filename: "image.png", contentType: "image/png")
    do {
      _ = try await commands.downloadAttachment(image, thumbnail: true)
      XCTFail("Thumbnail transfer must be bounded")
    } catch { XCTAssertTrue(error is URLError) }
    let task = Task { try await commands.downloadAttachment(image) }
    task.cancel()
    do {
      _ = try await task.value
      XCTFail("Cancelled download must not publish a file")
    } catch {
      XCTAssertTrue(error is CancellationError || (error as? URLError)?.code == .cancelled)
    }
  }
}
