import UIKit
import WebKit
import XCTest

@testable import Okou

@MainActor
final class ImagePreviewSwipeTests: XCTestCase, WKNavigationDelegate {
  private let pageLoaded = XCTestExpectation(description: "The local image document loaded")

  func testIntentionalDragOrFlickClosesInEitherVerticalDirection() {
    for sign: CGFloat in [-1, 1] {
      XCTAssertTrue(
        ImagePreviewPan.shouldDismiss(
          translation: CGPoint(x: 4, y: sign * 245), velocity: .zero))
      XCTAssertTrue(
        ImagePreviewPan.shouldDismiss(
          translation: CGPoint(x: 2, y: sign * 35), velocity: CGPoint(x: 0, y: sign * 900)))
    }
  }

  func testShortDragReversedFlickAndHorizontalPageStayInPreview() {
    XCTAssertFalse(
      ImagePreviewPan.shouldDismiss(translation: CGPoint(x: 0, y: 24), velocity: .zero))
    XCTAssertFalse(
      ImagePreviewPan.shouldDismiss(
        translation: CGPoint(x: 0, y: 35), velocity: CGPoint(x: 0, y: -900)))
    XCTAssertFalse(
      ImagePreviewPan.shouldDismiss(
        translation: CGPoint(x: 230, y: 110), velocity: CGPoint(x: 800, y: 200)))
  }

  func testWebPreviewDecodesAnExtensionlessAnimatedAttachmentFromItsOriginalBytes() async throws {
    // A two-frame GIF with one red pixel followed by one blue pixel.
    let bytes = try XCTUnwrap(
      Data(
        base64Encoded: "R0lGODlhAQABAIAAAP8AAAAA/yH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAA"
          + "ACwAAAAAAQABAAACAkQBACH5BAAKAAAALAAAAAABAAEAAAICTAEAOw=="))
    let source = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try bytes.write(to: source)
    defer { try? FileManager.default.removeItem(at: source) }
    let prepared = await AttachmentFileImporter.shared.imageDocument(source)
    let document = try XCTUnwrap(prepared)
    defer { withExtendedLifetime(document) {} }
    let webView = MessageImageWebView(document: document)
    webView.navigationDelegate = self
    defer { webView.stopLoading() }
    await fulfillment(of: [pageLoaded], timeout: 10)
    let decoded = try await webView.callAsyncJavaScript(
      "const image = document.images[0]; await image.decode(); return image.currentSrc;",
      arguments: [:], in: nil, contentWorld: .defaultClient)
    let url = try XCTUnwrap((decoded as? String).flatMap { URL(string: $0) })
    XCTAssertEqual(try Data(contentsOf: url), bytes)
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    pageLoaded.fulfill()
  }
}
