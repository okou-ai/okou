import UIKit
import XCTest

@testable import Okou

@MainActor
final class DesignSystemResourcesTests: XCTestCase {
  func testBrandFontsAreRegisteredAndRespectLargerText() throws {
    for name in [OkouTypography.sans, OkouTypography.mono] {
      let font = try XCTUnwrap(UIFont(name: name, size: 17))
      XCTAssertTrue(font.familyName.contains("Geist"))
    }
    let standard = OkouTypography.font(
      forTextStyle: .body, compatibleWith: UITraitCollection(preferredContentSizeCategory: .large))
    let larger = OkouTypography.font(
      forTextStyle: .body,
      compatibleWith: UITraitCollection(preferredContentSizeCategory: .accessibilityLarge))
    XCTAssertTrue(larger.familyName.contains("Geist"))
    XCTAssertGreaterThan(larger.pointSize, standard.pointSize)
  }

  func testEveryRegisteredIconAndBrandAssetIsLoadableFromTheAppBundle() {
    for name in OkouIconAssets.names {
      XCTAssertNotNil(OkouIcon.uiImage(name), "Missing compiled Lucide asset: \(name)")
    }
    for name in [OkouBrand.symbol, OkouBrand.wordmark, OkouAvatar.texture] {
      XCTAssertNotNil(UIImage(named: name), "Missing compiled brand asset: \(name)")
    }
  }
}
