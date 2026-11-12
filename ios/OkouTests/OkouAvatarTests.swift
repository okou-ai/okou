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

  func testMoodsMatchWebTimings() {
    XCTAssertEqual(OkouAvatarMood.allCases.count, 21)
    XCTAssertEqual(OkouAvatarMood.idle.cycle, 8)
    XCTAssertEqual(OkouAvatarMood.idle.hero, 1.2)
    XCTAssertEqual(OkouAvatarMood.wink.cycle, 2.83)
    XCTAssertEqual(OkouAvatarMood.wink.hero, 0.8)
    XCTAssertEqual(OkouAvatarMood.sleepy.hero, 3.3)
    for mood in OkouAvatarMood.allCases {
      XCTAssertLessThan(mood.hero, mood.cycle, mood.rawValue)
    }
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

  func testHeroFramesShowEachMoodsReadableMoment() {
    let wink = OkouAvatarRig.frame(.wink, at: OkouAvatarMood.wink.hero)
    // The right eye is shut in a smile; the left stays open.
    XCTAssertEqual(wink.opacities["eye-right-smile"] ?? 0, 1, accuracy: 0.01)
    XCTAssertEqual(wink.opacities["eye-left-dot"] ?? 0, 1, accuracy: 0.01)
    let laugh = OkouAvatarRig.frame(.laugh, at: OkouAvatarMood.laugh.hero)
    XCTAssertEqual(laugh.opacities["mouth-big-laugh"], 1)
    XCTAssertEqual(laugh.opacities["smile"], 0)
    let party = OkouAvatarRig.frame(.party, at: OkouAvatarMood.party.hero)
    XCTAssertFalse(party.torsoClipped)
    XCTAssertEqual(party.opacities["party-confetti"], 1)
    XCTAssertTrue(OkouAvatarRig.frame(.idle, at: 1.2).torsoClipped)
  }
}
