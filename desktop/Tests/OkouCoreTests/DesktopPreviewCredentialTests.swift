import Foundation
import XCTest

@testable import OkouCore

private final class PreviewHeaderProtocol: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func stopLoading() {}
  override func startLoading() {
    let body = [
      "preview": request.value(forHTTPHeaderField: "x-okou-desktop-preview") ?? "",
      "auth": request.value(forHTTPHeaderField: "Authorization") ?? "",
    ]
    client?.urlProtocol(
      self,
      didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!,
      cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: try! JSONEncoder().encode(body))
    client?.urlProtocolDidFinishLoading(self)
  }
}

final class DesktopPreviewCredentialTests: XCTestCase {
  private let origin = URL(string: "https://pr-123-api.vm6.ai")!

  func testOnlyMatchingDevelopmentBuildAndPrivateCredentialFileAreAccepted() throws {
    let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: file) }
    let json: [String: Any] = [
      "origin": origin.absoluteString, "expiresAt": Date().timeIntervalSince1970 + 900,
      "token": "test-ticket",
    ]
    let data = try JSONSerialization.data(withJSONObject: json)
    XCTAssertTrue(FileManager.default.createFile(atPath: file.path, contents: data, attributes: [.posixPermissions: 0o600]))
    func load(_ url: URL, _ bundleId: String) -> DesktopPreviewCredential? {
      DesktopPreviewCredential.load(for: url, bundleIdentifier: bundleId, path: file.path)
    }
    XCTAssertNotNil(load(origin, "ai.okou.desktop.dev"))
    XCTAssertNil(load(origin, "ai.okou.desktop"))
    XCTAssertNil(load(URL(string: "https://pr-124-api.vm6.ai")!, "ai.okou.desktop.dev"))
    XCTAssertNil(load(URL(string: "https://api.okou.ai")!, "ai.okou.desktop.dev"))
    try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: file.path)
    XCTAssertNil(load(origin, "ai.okou.desktop.dev"))
  }

  func testAPIRequestSendsPreviewCredentialOnlyToItsOriginAlongsideNormalAuth() async throws {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [PreviewHeaderProtocol.self]
    let session = URLSession(configuration: config)
    defer { session.invalidateAndCancel() }
    let credential = DesktopPreviewCredential(
      origin: origin.absoluteString, expiresAt: Date().timeIntervalSince1970 + 60, token: "test-ticket")
    let client = APIClient(baseURL: origin, version: "test", session: session, previewCredential: credential)
    let result = try await client.request(ApiRoutes.authMe, token: "test-session")
    let headers = try JSONDecoder().decode([String: String].self, from: result.data)
    XCTAssertEqual(headers, ["preview": "test-ticket", "auth": "Bearer test-session"])
    for otherURL in [
      "http://pr-123-api.vm6.ai", "https://pr-123-api.vm6.ai.example.com", "https://api.okou.ai",
      "https://pr-123-api.vm6.ai:8443", "https://pr-124-api.vm6.ai",
    ] {
      XCTAssertNil(credential.value(for: URL(string: otherURL)!))
    }
    let expired = DesktopPreviewCredential(origin: origin.absoluteString, expiresAt: 0, token: "old")
    XCTAssertNil(expired.value(for: origin))
  }

  func testRedirectIsDeclinedForCredentialedRequests() async {
    let session = URLSession(configuration: .ephemeral)
    defer { session.invalidateAndCancel() }
    let next = URLRequest(url: URL(string: "https://example.com/redirected")!)
    let redirect = HTTPURLResponse(
      url: origin, statusCode: 307, httpVersion: nil, headerFields: ["Location": next.url!.absoluteString])!
    for protected in [false, true] {
      var original = URLRequest(url: origin)
      if protected { original.setValue("test-ticket", forHTTPHeaderField: DesktopPreviewCredential.header) }
      let task = session.dataTask(with: original)
      let result: URLRequest? = await withCheckedContinuation { continuation in
        APIRequestMetrics().urlSession(
          session, task: task, willPerformHTTPRedirection: redirect, newRequest: next
        ) { continuation.resume(returning: $0) }
      }
      task.cancel()
      XCTAssertEqual(result?.url, protected ? nil : next.url)
    }
  }
}
