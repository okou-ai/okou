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
    try await waitForBusinessResult { viewer.preview?.contentURL != nil }
    XCTAssertEqual(
      viewer.preview?.contentURL?.absoluteString,
      "https://preview-1.example.invalid/lessons?week=2#serve")

    XCTAssertTrue(viewer.renewHTMLSignature(status: 404))
    try await waitForBusinessResult {
      viewer.preview?.contentURL?.host == "preview-2.example.invalid"
    }
    XCTAssertEqual(
      viewer.preview?.contentURL?.absoluteString,
      "https://preview-2.example.invalid/lessons?week=2#serve")
    XCTAssertEqual(viewer.preview?.artifact.source, resource.source)
    XCTAssertFalse(viewer.renewHTMLSignature(status: 403))

    viewer.retry()
    try await waitForBusinessResult {
      viewer.preview?.contentURL?.host == "preview-3.example.invalid"
    }
    // A missing page under a still-valid grant is not an expired credential.
    XCTAssertFalse(viewer.renewHTMLSignature(status: 404))
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
    try await waitForBusinessResult { viewer.preview?.contentURL != nil }
    denied.withLock { $0 = true }

    XCTAssertTrue(viewer.renewHTMLSignature(status: 404))
    try await waitForBusinessResult { viewer.preview?.error != nil }
    XCTAssertEqual(viewer.preview?.error, "You do not have permission to view this result.")
    XCTAssertNil(viewer.preview?.contentURL)
  }
}
