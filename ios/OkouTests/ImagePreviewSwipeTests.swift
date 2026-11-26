import UIKit
import XCTest

@testable import Okou

@MainActor
final class ImagePreviewSwipeTests: XCTestCase {
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

  func testLocalImageDocumentLoadsOriginalBytesWithASafeFilename() throws {
    let source = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
      .appendingPathExtension("gif")
    let bytes = Data("image fixture".utf8)
    try bytes.write(to: source)
    defer { try? FileManager.default.removeItem(at: source) }
    let document = try XCTUnwrap(try LocalImageDocument(image: source))
    let resource = document.directory.appendingPathComponent("image.gif")
    XCTAssertEqual(try Data(contentsOf: resource), bytes)
    let html = try String(contentsOf: document.page, encoding: .utf8)
    XCTAssertTrue(html.contains("src=\"image.gif\""))
    XCTAssertFalse(html.contains(source.lastPathComponent))
  }
}
