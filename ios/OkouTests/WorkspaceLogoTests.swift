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
}
