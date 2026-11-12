import ChatData
import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class HostedSitePreviewTests: XCTestCase {
  func testExpiredSitePreviewRenewsOnceAndManualRetryResolvesFreshAccess() async throws {
    let resolution = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      if request.url?.path == "/api/chat-threads/thread/artifacts" {
        return ChatHTTPResponse(body: "{\"runs\":[]}")
      }
      guard request.url?.path == "/api/host/sites/court/preview" else {
        throw URLError(.unsupportedURL)
      }
      let attempt = resolution.withLock {
        $0 += 1
        return $0
      }
      let expiresAt = attempt == 1 ? "2000-01-01T00:00:00Z" : "2099-01-01T00:00:00Z"
      return ChatHTTPResponse(
        body: """
          {"url":"https://preview-\(attempt).example.invalid/","expiresAt":"\(expiresAt)"}
          """)
    }
    let commands = ChatCommands(client: fixture.client, sync: ChatSync(client: fixture.client))
    let viewer = MessageArtifactStore(
      service: commands.artifacts, threadID: "thread", webURL: URL(string: "https://app.okou.ai")!,
      markdown: MessageMarkdownCache(baseURL: fixture.baseURL),
      didFail: { _ in XCTFail("Preview renewal must not expire the account") })
    defer { viewer.close() }
    let resource = try XCTUnwrap(viewer.resource("https://court.okou.app/lessons?week=2#serve"))
    viewer.open(resource)
    let first = try await artifactPreviewTask(viewer).value
    XCTAssertEqual(
      first.contentURL?.absoluteString,
      "https://preview-1.example.invalid/lessons?week=2#serve")

    let firstID = try XCTUnwrap(viewer.preview?.id)
    XCTAssertTrue(viewer.renewHTMLSignature(status: 404, content: first, previewID: firstID))
    let renewed = try await artifactPreviewTask(viewer).value
    XCTAssertEqual(
      renewed.contentURL?.absoluteString,
      "https://preview-2.example.invalid/lessons?week=2#serve")
    XCTAssertEqual(renewed.artifact.source, resource.source)
    let renewedID = try XCTUnwrap(viewer.preview?.id)
    XCTAssertFalse(viewer.renewHTMLSignature(status: 403, content: renewed, previewID: renewedID))

    viewer.retry()
    let retried = try await artifactPreviewTask(viewer).value
    XCTAssertEqual(retried.contentURL?.host, "preview-3.example.invalid")
    let retryID = try XCTUnwrap(viewer.preview?.id)
    XCTAssertFalse(viewer.renewHTMLSignature(status: 403, content: first, previewID: firstID))
    // A missing page under a still-valid grant is not an expired credential.
    XCTAssertFalse(viewer.renewHTMLSignature(status: 404, content: retried, previewID: retryID))
  }

  func testSitePreviewRenewalCannotRetainAccessAfterTheAuthorityDeniesIt() async throws {
    let denied = Mutex(false)
    let fixture = ChatHTTPFixture { request in
      if request.url?.path == "/api/chat-threads/thread/artifacts" {
        return ChatHTTPResponse(body: "{\"runs\":[]}")
      }
      guard request.url?.path == "/api/host/sites/court/preview" else {
        throw URLError(.unsupportedURL)
      }
      if denied.withLock({ $0 }) {
        return ChatHTTPResponse(
          status: 403, body: "{\"error\":{\"message\":\"Access denied\"}}")
      }
      return ChatHTTPResponse(
        body: """
          {"url":"https://preview.example.invalid/","expiresAt":"2000-01-01T00:00:00Z"}
          """)
    }
    let commands = ChatCommands(client: fixture.client, sync: ChatSync(client: fixture.client))
    let viewer = MessageArtifactStore(
      service: commands.artifacts, threadID: "thread", webURL: URL(string: "https://app.okou.ai")!,
      markdown: MessageMarkdownCache(baseURL: fixture.baseURL),
      didFail: { _ in XCTFail("Site access denial must not expire the account") })
    defer { viewer.close() }
    let resource = try XCTUnwrap(viewer.resource("https://court.okou.app/"))
    viewer.open(resource)
    let content = try await artifactPreviewTask(viewer).value
    let id = try XCTUnwrap(viewer.preview?.id)
    denied.withLock { $0 = true }

    XCTAssertTrue(viewer.renewHTMLSignature(status: 404, content: content, previewID: id))
    let rejected = await (try artifactPreviewTask(viewer)).result
    XCTAssertThrowsError(try rejected.get()) { error in
      XCTAssertEqual(
        MessageArtifactStore.message(for: error), "You do not have permission to view this result.")
    }
  }
}
