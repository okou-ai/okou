import Foundation
import Textual
import XCTest

@testable import Okou

final class MessageTableLayoutTests: XCTestCase {
  private let viewport = MessageTableLayout.Viewport(width: 360, fontSize: 17, scale: 3)

  func testWideTableRetainsReadingOrderAndOverflow() throws {
    let content = try AttributedString(
      markdown: markdown(status: "**Status**"), including: \.textual)
    let layout = try XCTUnwrap(MessageTableLayout.prepare(content, viewport: viewport).values.first)
    XCTAssertGreaterThan(layout.contentWidth, viewport.width)
    XCTAssertLessThanOrEqual(layout.size.width, layout.contentWidth)
    XCTAssertLessThan(layout.cells[2].frame.minX + 13, viewport.width)
    XCTAssertEqual(
      layout.cells.suffix(4).map { String($0.content.characters) },
      ["Row 10", "A wide column with several inline values", "Status", "10"])
  }

  func testLinkedCellKeepsTheExistingRenderer() throws {
    let content = try AttributedString(
      markdown: markdown(status: "[Status](https://example.invalid)"), including: \.textual)
    XCTAssertTrue(MessageTableLayout.prepare(content, viewport: viewport).isEmpty)
  }

  private func markdown(status: String) -> String {
    let rows = (1...10).map {
      "| Row \($0) | A wide column with several inline values | \(status) | \($0) |"
    }
    return (["| Item | Details | State | Score |", "|---|---|---|---|"] + rows).joined(
      separator: "\n")
  }
}
