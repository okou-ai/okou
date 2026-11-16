import SwiftUI
import XCTest

@testable import Okou

final class OkouAvatarTests: XCTestCase {
  func testPathDataReadsRelativeSmoothAndArcCommands() {
    let square = Path(okouSVG: "M0 0H10V10H0Z").boundingRect
    XCTAssertEqual(square, CGRect(x: 0, y: 0, width: 10, height: 10))
    // Web's teardrop: relative curves, compact numbers and an arc closing its round end.
    let drop = Path(okouSVG: "M0-4C-1.1-1.5-2.5.2-2.5 1.7a2.5 2.5 0 0 0 5 0C2.5.2 1.1-1.5 0-4Z")
      .boundingRect
    XCTAssertEqual(drop.minX, -2.5, accuracy: 0.01)
    XCTAssertEqual(drop.maxX, 2.5, accuracy: 0.01)
    XCTAssertEqual(drop.minY, -4, accuracy: 0.01)
    XCTAssertEqual(drop.maxY, 4.2, accuracy: 0.01)
    // A smooth quadratic continues the reflected control: Web's anger steam rises in an S.
    let steam = Path(okouSVG: "M100 225q-22-12-7-26t-7-25").boundingRect
    XCTAssertEqual(steam.minY, 174, accuracy: 0.01)
    XCTAssertLessThan(steam.minX, 93)
  }

  func testEveryNodeTheRigDrawsExistsInTheArtwork() {
    var ids = Set<String>()
    func collect(_ node: OkouAvatarNode) {
      if let id = node.id { ids.insert(id) }
      if case .shape = node.content { return }
      if case .some(.shape(let clip)) = node.clip { ids.insert(clip) }
      node.children.forEach(collect)
    }
    collect(OkouAvatarArtwork.scene)
    for mood in OkouAvatarMood.allCases {
      let frame = OkouAvatarRig.frame(mood, at: mood.hero)
      let written = Set(frame.transforms.keys).union(frame.opacities.keys).union(frame.paths.keys)
      XCTAssertEqual(written.subtracting(ids), [], mood.rawValue)
    }
  }

  func testAFrameIsAFunctionOfMoodAndTime() {
    let first = OkouAvatarRig.frame(.laugh, at: 2.4)
    let second = OkouAvatarRig.frame(.laugh, at: 2.4)
    XCTAssertEqual(first.transforms, second.transforms)
    XCTAssertEqual(first.opacities, second.opacities)
    XCTAssertNotEqual(
      OkouAvatarRig.frame(.idle, at: 1).transforms["head-motion"],
      OkouAvatarRig.frame(.idle, at: 3).transforms["head-motion"])
  }
}
