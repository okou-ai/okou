#if canImport(WebKit)
  import WebKit
  import XCTest

  @MainActor
  private final class SnapshotPageNavigation: NSObject, WKNavigationDelegate {
    let loaded: XCTestExpectation
    init(_ loaded: XCTestExpectation) { self.loaded = loaded }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
      loaded.fulfill()
    }
  }

  final class SnapshotWebKitTests: XCTestCase, @unchecked Sendable {
    @MainActor
    func testOffscreenDesktopPageOffersADataChannelWithoutMediaPermission() async throws {
      let directory = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      let page = directory.appendingPathComponent("Resources/snapshot-peer.html")
      let configuration = WKWebViewConfiguration()
      configuration.websiteDataStore = .nonPersistent()
      let view = WKWebView(frame: .zero, configuration: configuration)
      let loaded = expectation(description: "The bundled sender page loads")
      let navigation = SnapshotPageNavigation(loaded)
      view.navigationDelegate = navigation
      defer {
        view.evaluateJavaScript("window.snapshotPeer?.close()")
        view.navigationDelegate = nil
      }
      view.loadFileURL(page, allowingReadAccessTo: page)
      await fulfillment(of: [loaded], timeout: 10)
      let value = try await view.callAsyncJavaScript(
        "return await snapshotPeer.offer([], false)", in: nil, contentWorld: .page)
      let offer = try XCTUnwrap(value as? String)
      XCTAssertTrue(offer.contains("m=application "))
      XCTAssertTrue(offer.contains("webrtc-datachannel"))
      XCTAssertTrue(offer.contains("a=fingerprint:sha-256 "))
      XCTAssertFalse(offer.contains("m=audio "))
      XCTAssertFalse(offer.contains("m=video "))
      withExtendedLifetime(navigation) {}
    }
  }
#endif
