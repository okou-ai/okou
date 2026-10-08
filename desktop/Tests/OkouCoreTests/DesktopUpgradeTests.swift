import Foundation
import XCTest

@testable import OkouCore

final class DesktopUpgradeTests: XCTestCase {
  func testNumericFloorAndUpdateCandidateSelection() {
    for (installed, minimum, required) in [
      ("0.50.1", "0.51.0", true), ("0.51.0", "0.51.0", false),
      ("0.51.1", "0.51.0", false), ("0.9.9", "0.51.0", true),
      ("1.0.0", "0.51.0", false), ("invalid", "0.51.0", true),
    ] {
      let policy = DesktopCompatibility(version: installed, minimumSupportedVersion: minimum)
      XCTAssertEqual(policy.required, required)
    }
    let policy = DesktopCompatibility(version: "0.50.1", minimumSupportedVersion: "0.51.0")
    XCTAssertFalse(policy.permitsUpdate("0.50.2"))
    XCTAssertFalse(policy.permitsUpdate("0.51.0-beta"))
    XCTAssertTrue(policy.permitsUpdate("0.51.0"))
    XCTAssertTrue(policy.permitsUpdate("0.100.0"))
  }
  func testFailureAndOlderAPIKeepConfirmedRejectionUntilExplicitRollback() throws {
    var policy = DesktopCompatibility(version: "0.51.0")
    policy.reject(minimum: "0.52.0")
    for status in [503, 401, 200] {
      XCTAssertThrowsError(
        try policy.apply(APIResponse(status: status, body: .object([:]), retryAfter: nil)))
      XCTAssertTrue(policy.required)
    }
    try policy.apply(APIResponse(status: 404, body: .null, retryAfter: nil))
    XCTAssertTrue(policy.required)
    try policy.apply(
      APIResponse(status: 200, body: .object(["minimumSupportedVersion": .null]), retryAfter: nil))
    XCTAssertFalse(policy.required)
    XCTAssertNil(policy.minimumSupportedVersion)
  }
  func testRejectionWithoutStructuredFloorSurvivesRelaunch() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    var policy = DesktopCompatibility(version: "0.51.0")
    policy.reject(minimum: nil)
    let preferences = try Preferences(directory: directory)
    try preferences.set([
      "desktopUpdateRequired": .bool(policy.rejected), "desktopRejectedVersion": .string("0.51.0"),
    ])
    let reloaded = try Preferences(directory: directory)
    let restored = DesktopCompatibility(
      version: "0.51.0",
      minimumSupportedVersion: reloaded.string("desktopMinimumSupportedVersion"),
      rejected: reloaded.bool("desktopUpdateRequired")
        && reloaded.string("desktopRejectedVersion") == "0.51.0")
    XCTAssertTrue(restored.required)
    XCTAssertTrue(restored.permitsUpdate("0.52.0"))
    let upgraded = DesktopCompatibility(
      version: "0.52.0",
      minimumSupportedVersion: reloaded.string("desktopMinimumSupportedVersion"),
      rejected: reloaded.bool("desktopUpdateRequired")
        && reloaded.string("desktopRejectedVersion") == "0.52.0")
    XCTAssertFalse(upgraded.required)
  }
}
