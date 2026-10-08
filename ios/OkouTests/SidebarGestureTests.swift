import CoreGraphics
import XCTest

@testable import Okou

final class SidebarGestureTests: XCTestCase {
  func testSidebarLeavesVerticalScrollingCodeTablesAndArchiveGesturesAvailable() {
    XCTAssertTrue(
      SidebarGesturePolicy.canBegin(
        isOpen: false, sidebarWidth: 300, startX: 12, velocity: CGPoint(x: 300, y: 20)))
    XCTAssertFalse(
      SidebarGesturePolicy.canBegin(
        isOpen: false, sidebarWidth: 300, startX: 12, velocity: CGPoint(x: 20, y: 300)))
    XCTAssertFalse(
      SidebarGesturePolicy.canBegin(
        isOpen: false, sidebarWidth: 300, startX: 200, velocity: CGPoint(x: 300, y: 0)))
    XCTAssertFalse(
      SidebarGesturePolicy.canBegin(
        isOpen: true, sidebarWidth: 300, startX: 150, velocity: CGPoint(x: -300, y: 0)))
    XCTAssertTrue(
      SidebarGesturePolicy.canBegin(
        isOpen: true, sidebarWidth: 300, startX: 350, velocity: CGPoint(x: -300, y: 0)))
    XCTAssertFalse(
      SidebarGesturePolicy.canBegin(
        isOpen: true, sidebarWidth: 300, startX: 350, velocity: CGPoint(x: -20, y: 300)))
  }

  func testReleaseUsesDistanceOrFlickDirectionAndCancellationRestoresStartingState() {
    XCTAssertFalse(
      SidebarGesturePolicy.settlesOpen(
        wasOpen: false, sidebarWidth: 300, translation: 50, velocity: 100, cancelled: false))
    XCTAssertTrue(
      SidebarGesturePolicy.settlesOpen(
        wasOpen: false, sidebarWidth: 300, translation: 200, velocity: 100, cancelled: false))
    XCTAssertTrue(
      SidebarGesturePolicy.settlesOpen(
        wasOpen: false, sidebarWidth: 300, translation: 50, velocity: 600, cancelled: false))
    XCTAssertFalse(
      SidebarGesturePolicy.settlesOpen(
        wasOpen: true, sidebarWidth: 300, translation: -50, velocity: -600, cancelled: false))
    XCTAssertFalse(
      SidebarGesturePolicy.settlesOpen(
        wasOpen: false, sidebarWidth: 300, translation: 250, velocity: 600, cancelled: true))
    XCTAssertTrue(
      SidebarGesturePolicy.settlesOpen(
        wasOpen: true, sidebarWidth: 300, translation: -250, velocity: -600, cancelled: true))
  }
}
