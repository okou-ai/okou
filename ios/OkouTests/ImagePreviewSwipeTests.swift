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

  func testSystemRenderedImageFitsAndZoomsInTheLocalScrollView() {
    let rendered = UIView()
    let canvas = MessageImageScrollView(content: rendered, accessibilityLabel: "Image")
    canvas.frame = CGRect(x: 0, y: 0, width: 390, height: 700)
    canvas.layoutIfNeeded()
    XCTAssertEqual(rendered.bounds.size, canvas.bounds.size)
    XCTAssertTrue(canvas.hitTest(CGPoint(x: 195, y: 350), with: nil) === canvas)

    canvas.setZoomScale(2, animated: false)
    XCTAssertEqual(rendered.frame.size, CGSize(width: 780, height: 1400))
    XCTAssertGreaterThan(canvas.zoomScale, canvas.minimumZoomScale)
  }
}
