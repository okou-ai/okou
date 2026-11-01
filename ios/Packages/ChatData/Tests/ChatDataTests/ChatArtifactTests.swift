import ChatData
import ChatDataTestSupport
import ChatDomain
import Foundation
import Synchronization
import XCTest

final class ChatArtifactTests: XCTestCase {
  private let webURL = URL(string: "https://app.okou.ai")!
  private let reference = "123456781234423482341234567890ab"

  func testRecognizedReferencesKeepIdentityAndRejectForeignOrMalformedReferences() throws {
    let apiURL = URL(string: "https://api.okou.ai")!
    let path = "/artifacts/\(reference).html#slide-2"
    let relative = try XCTUnwrap(ChatArtifactReference.parse(path, webURL: webURL, apiURL: apiURL))
    XCTAssertEqual(relative.source, .reference(reference + ".html", fragment: "slide-2"))
    XCTAssertEqual(
      ChatArtifactReference.parse("https://app.okou.ai" + path, webURL: webURL, apiURL: apiURL),
      relative)
    for value in [
      "https://evil.invalid" + path, "https://app.okou.ai:8443" + path,
      "https://user@app.okou.ai" + path, "/artifacts/\(reference).html?token=secret#slide-2",
      "//app.okou.ai" + path,
      "/artifacts/invalid.png", "/artifacts/\(reference).HTML", "/artifacts/\(reference).html?x=1",
      "javascript:alert(1)", "https://example.com/report.pdf",
      "https://static.okou.ai/unlisted.html", "https://demo.sites.vm7.io/",
      "https://not-okou.app/page", "https://files.sites.vm7.io/ordinary.html",
    ] { XCTAssertNil(ChatArtifactReference.parse(value, webURL: webURL, apiURL: apiURL), value) }
    let legacy = try XCTUnwrap(
      ChatArtifactReference.parse(
        "/f/reader/id/report.pdf?temporary=discarded#page=2", webURL: webURL, apiURL: apiURL))
    XCTAssertEqual(
      legacy.source,
      .published(URL(string: "https://cdn.vm0.io/artifacts/user_reader/id/report.pdf#page=2")!))
    for value in [
      "https://a.okou.io/abcdefgh12.pdf", "https://files.sites.vm7.io/1234567890abcdef12345678.pdf",
      "https://cdn.okou.io/artifacts/user/id/report.pdf", "/f/user/id/report.pdf",
      "https://demo.okou.app/", "https://demo.sites.vm0.io/",
      "https://www.okou.ai/f/reader/id/report.pdf",
      "https://platform.okou.ai/f/reader/id/report.pdf",
      "https://a.okou.io/abcdefgh12.tar.gz",
    ] { XCTAssertNotNil(ChatArtifactReference.parse(value, webURL: webURL, apiURL: apiURL), value) }
  }

  func testHostedSiteRecognitionUsesTheConfiguredEnvironment() throws {
    let preview = URL(string: "https://app.vm7.ai")!
    let api = URL(string: "https://api.vm7.ai")!
    XCTAssertNotNil(
      ChatArtifactReference.parse("https://demo.sites.vm7.io/", webURL: preview, apiURL: api))
    XCTAssertNil(
      ChatArtifactReference.parse("https://demo.okou.app/", webURL: preview, apiURL: api))
    XCTAssertNil(
      ChatArtifactReference.parse("https://demo.sites.vm0.io/", webURL: preview, apiURL: api))
  }

  func testHostedSitesResolveAuthorizedPreviewsWithoutChangingTheirStableLinks() async throws {
    let sourceURL = URL(
      string: "https://court.okou.app/lessons/serve%20practice.html?view=week%2F2#drill%203")!
    let previewURL = URL(string: "https://site-preview.example.invalid/")!
    let coverURL = URL(string: "https://cover.example.invalid/preview.png")!
    let fixture = ChatHTTPFixture { request in
      guard request.url?.path == "/api/host/sites/court/preview" else {
        throw URLError(.unsupportedURL)
      }
      XCTAssertEqual(request.httpMethod, "GET")
      XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer scope-token")
      XCTAssertEqual(
        URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems,
        [URLQueryItem(name: "hostname", value: "court.okou.app")])
      return ChatHTTPResponse(
        body: """
          {"url":"\(previewURL)","expiresAt":"2099-01-01T00:00:00Z","previewImageUrl":"\(coverURL)"}
          """)
    }
    let artifact = try XCTUnwrap(
      ChatArtifactReference.parse(
        sourceURL.absoluteString, webURL: webURL, apiURL: fixture.baseURL))
    XCTAssertEqual(artifact.source, .hostedSite(sourceURL))
    let resolved = try await commands(fixture).artifacts.resolve(artifact)
    XCTAssertEqual(resolved.artifact, artifact)
    XCTAssertEqual(
      resolved.contentURL.absoluteString,
      "https://site-preview.example.invalid/lessons/serve%20practice.html?view=week%2F2#drill%203")
    XCTAssertEqual(resolved.previewImageURL, coverURL)
    XCTAssertNotNil(resolved.expiresAt)
  }

  func testPublicHostedSitePreviewKeepsItsOriginalAddress() async throws {
    let sourceURL = URL(string: "https://court.sites.vm7.io/schedule?day=2#evening")!
    let fixture = ChatHTTPFixture { request in
      guard request.url?.path == "/api/host/sites/court/preview" else {
        throw URLError(.unsupportedURL)
      }
      return ChatHTTPResponse(body: "{\"url\":\"https://court.sites.vm7.io/\",\"expiresAt\":null}")
    }
    let artifact = try XCTUnwrap(
      ChatArtifactReference.parse(
        sourceURL.absoluteString, webURL: URL(string: "https://app.vm7.ai")!,
        apiURL: fixture.baseURL))
    let resolved = try await commands(fixture).artifacts.resolve(artifact)
    XCTAssertEqual(resolved.contentURL, sourceURL)
    XCTAssertNil(resolved.expiresAt)
  }

  func testPublishedResourceCapabilitiesKeepTheirCredentialWithoutRequestingSiteAccess() async throws {
    let fixture = ChatHTTPFixture { _ in throw URLError(.unsupportedURL) }
    for address in [
      "https://pv-token.okou.app/slide.html#next",
      "https://ps-token.okou.app/index.html", "https://sh-token.okou.app/",
      "https://legacy.sites.vm0.io/", "https://cdn.okou.io/artifacts/user/id/report.pdf",
    ] {
      let url = URL(string: address)!
      let artifact = try XCTUnwrap(
        ChatArtifactReference.parse(address, webURL: webURL, apiURL: fixture.baseURL))
      let resolved = try await commands(fixture).artifacts.resolve(artifact)
      XCTAssertEqual(resolved.contentURL, url)
    }
  }

  func testDeniedHostedSitePreviewSurfacesTheAuthorityResponse() async throws {
    for status in [401, 403, 404] {
      let fixture = ChatHTTPFixture { request in
        guard request.url?.path == "/api/host/sites/court/preview" else {
          throw URLError(.unsupportedURL)
        }
        return ChatHTTPResponse(
          status: status, body: "{\"error\":{\"message\":\"Website preview is unavailable\"}}")
      }
      let artifact = try XCTUnwrap(
        ChatArtifactReference.parse(
          "https://court.okou.app/", webURL: webURL, apiURL: fixture.baseURL))
      do {
        _ = try await commands(fixture).artifacts.resolve(artifact)
        XCTFail("Unavailable sites must not resolve a preview")
      } catch { XCTAssertEqual((error as? APIClientError)?.statusCode, status) }
    }
  }

  func testAuthorizedDownloadRenewsRejectedSignatureAndNeverSendsAppCredentialsToStorage()
    async throws
  {
    let storageRequests = Mutex<[URLRequest]>([])
    let server = try ChatFileHTTPServer { request in
      storageRequests.withLock { $0.append(request) }
      return request.url?.path == "/expired"
        ? .init(status: 403)
        : .init(headers: ["Content-Type": "text/plain"], body: Data("Authorized result".utf8))
    }
    let origin = try await server.start()
    defer { server.stop() }
    let authorizations = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      XCTAssertEqual(
        request.url?.path, "/api/artifact-references/123456781234423482341234567890ab.txt")
      XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer scope-token")
      let attempt = authorizations.withLock {
        $0 += 1
        return $0
      }
      return ChatHTTPResponse(
        body: """
          {"url":"\(origin)/content","downloadUrl":"\(origin)/\(attempt == 1 ? "expired" : "fresh")",        "expiresAt":"2026-10-21T00:00:00Z","filename":"../../notes.txt","contentType":"text/plain",        "target":{"kind":"file","id":"12345678-1234-4234-8234-1234567890ab"}}
          """)
    }
    let service = commands(fixture).artifacts
    let artifact = try XCTUnwrap(
      ChatArtifactReference.parse(
        "/artifacts/\(reference).txt", webURL: webURL, apiURL: fixture.baseURL))
    var file: ChatAttachmentFile?
    let result = try await service.download(artifact)
    file = result.1
    XCTAssertEqual(result.0.filename, "../../notes.txt")
    XCTAssertEqual(file?.url.lastPathComponent, "notes.txt")
    XCTAssertEqual(try Data(contentsOf: result.1.url), Data("Authorized result".utf8))
    XCTAssertEqual(authorizations.withLock { $0 }, 2)
    XCTAssertEqual(storageRequests.withLock { $0.map { $0.url?.path } }, ["/expired", "/fresh"])
    for request in storageRequests.withLock({ $0 }) {
      XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
      XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
      XCTAssertNil(request.value(forHTTPHeaderField: "X-Client-Type"))
      XCTAssertNil(request.value(forHTTPHeaderField: "X-Client-Version"))
    }
    file = nil
  }

  func testCatalogAndAuthorizedHTMLKeepPresentationMetadataWithoutTreatingPPTXAsHTML() async throws
  {
    let fixture = ChatHTTPFixture { request in
      if request.url?.path.hasSuffix("/artifacts") == true {
        return ChatHTTPResponse(
          body: """
            {"runs":[{"runId":"run","files":[
            {"id":"html","url":"/artifacts/abcdefgh12.html","filename":"Quarterly review.html",          "contentType":"text/html","size":1200,"artifactKind":"presentation-html","createdAt":"2026-10-21T00:00:00Z"},
            {"id":"ppt","url":"/artifacts/abcdefgh13.pptx","filename":"Quarterly review.pptx",          "contentType":"application/vnd.openxmlformats-officedocument.presentationml.presentation","size":3200,          "createdAt":"2026-10-21T00:00:00Z"}]}]}
            """)
      }
      return ChatHTTPResponse(
        body: """
          {"url":"https://content.example.invalid/deck/index.html?signature=temporary",        "downloadUrl":"https://content.example.invalid/deck.zip?signature=temporary",        "filename":"Quarterly review.html","contentType":"text/html"}
          """)
    }
    let service = commands(fixture).artifacts
    let items = try await service.list(threadID: "thread", webURL: webURL)
    XCTAssertEqual(items.count, 2)
    XCTAssertTrue(items[0].isHTMLPresentation)
    XCTAssertEqual(items[1].kind, .file)
    XCTAssertEqual(items[1].size, 3200)
    let resolved = try await service.resolve(items[0])
    XCTAssertTrue(resolved.artifact.isHTMLPresentation)
    XCTAssertEqual(resolved.contentURL.path, "/deck/index.html")
    XCTAssertEqual(resolved.downloadURL.path, "/deck.zip")
    XCTAssertEqual(resolved.artifact.source, items[0].source)
  }

  func testDeletedAndDeniedResourcesNeverAcquireFileBytes() async throws {
    for status in [403, 404, 410] {
      let fixture = ChatHTTPFixture { _ in
        ChatHTTPResponse(status: status, body: "{\"error\":{\"message\":\"Unavailable\"}}")
      }
      let source = ChatArtifact(
        source: .reference("abcdefgh12.pdf", fragment: ""), filename: "Report.pdf")
      do {
        _ = try await commands(fixture).artifacts.download(source)
        XCTFail("Unavailable resources must not download")
      } catch { XCTAssertEqual((error as? APIClientError)?.statusCode, status) }
    }
  }

  private func commands(_ fixture: ChatHTTPFixture) -> ChatCommands {
    let client = APIClient(
      baseURL: fixture.baseURL, clientVersion: fixture.clientVersion, session: fixture.session
    ) { "scope-token" }
    return ChatCommands(client: client, sync: ChatSync(client: client))
  }
}
