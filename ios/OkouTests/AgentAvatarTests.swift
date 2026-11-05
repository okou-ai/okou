import UIKit
import XCTest

@testable import Okou

@MainActor
final class AgentAvatarTests: XCTestCase {
  func testPersistedWebAvatarFamiliesResolveToShippedArtwork() throws {
    let values = [
      "preset:1", "svg:r4s2h5c4f3d",
      OkouAvatarAssets.baseURL
        + "?face=round&hair=high-bun&expression=happy&skin=gold&hairColor=blue&sweater=lime",
      OkouAvatarAssets.baseURL
        + "?face=tall&hair=halo&expression=calm&skin=deep&hairColor=black&sweater=teal",
    ]
    for value in values {
      let avatar = try XCTUnwrap(OkouAvatarComposition.resolve(value), value)
      for path in avatar.behind + avatar.head + avatar.front {
        XCTAssertNotNil(UIImage(named: OkouAvatarComposition.assetName(path)), path)
      }
    }
  }

  func testOlderComposerURLKeepsWebInheritedSweaterColor() throws {
    let value =
      OkouAvatarAssets.baseURL
      + "?face=round&hair=high-bun&expression=happy&skin=gold&hairColor=blue"
    let avatar = try XCTUnwrap(OkouAvatarComposition.resolve(value))
    XCTAssertEqual(avatar.front, ["sweater/pink.svg"])
  }

  func testUploadedImagesAndInvalidConfigsAreNotReinterpretedAsAnotherAgent() {
    XCTAssertNil(OkouAvatarComposition.resolve("https://example.invalid/avatar.png"))
    XCTAssertNil(OkouAvatarComposition.resolve("svg:r9s0h1c1f1h"))
    XCTAssertNil(OkouAvatarComposition.resolve(OkouAvatarAssets.baseURL + "?face=unknown"))
    XCTAssertNil(
      OkouAvatarComposition.resolve(
        OkouAvatarAssets.baseURL
          + "?face=round&hair=high-bun&expression=full-beard&skin=gold&hairColor=blue"))
    XCTAssertEqual(
      OkouAvatarComposition.resolve("preset:99"), OkouAvatarComposition.resolve("preset:0"))
  }
}
