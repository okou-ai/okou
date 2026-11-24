import UIKit
import XCTest

@testable import Okou

@MainActor
final class WorkspaceLogoTests: XCTestCase {
  func testPersistedWorkspaceIDsSelectTheSameBrandColorwayAsWeb() {
    XCTAssertEqual(OkouWorkspaceLogo.defaultAssetName(for: "org_one"), "WorkspaceDefault-2")
    XCTAssertEqual(OkouWorkspaceLogo.defaultAssetName(for: "org_two"), "WorkspaceDefault-0")
    XCTAssertEqual(OkouWorkspaceLogo.defaultAssetName(for: "org_设计😀"), "WorkspaceDefault-2")
  }

  func testEveryDefaultWorkspaceLogoIsCompiledForOfflineUse() {
    for index in 0..<8 {
      XCTAssertNotNil(UIImage(named: "WorkspaceDefault-\(index)"))
    }
  }

  func testWorkspaceInitialFollowsWeb() {
    let cases: [(String, String?)] = [
      ("Acme Inc", "A"), ("okou team", "O"), ("  élan studio", "É"), ("123 Labs", "1"),
      ("字节跳动", "字"), ("한국 팀", "한"), ("ßeta GmbH", "ß"), ("🚀 Launch Team", "L"),
      ("workspace-3f9a2c1d", nil), ("👋🎉", nil), ("   ", nil), ("workspace-design", "W")
    ]
    for (name, initial) in cases {
      XCTAssertEqual(OkouWorkspaceLogo.initial(for: name), initial, name)
    }
  }

  func testCJKInitialsAreSetSmallerThanLatin() {
    XCTAssertEqual(OkouWorkspaceLogo.initialPointSize("A", tile: 32), 16)
    XCTAssertEqual(OkouWorkspaceLogo.initialPointSize("字", tile: 32), 32 * 0.44, accuracy: 0.001)
    XCTAssertEqual(OkouWorkspaceLogo.initialPointSize("한", tile: 32), 32 * 0.44, accuracy: 0.001)
  }
}
