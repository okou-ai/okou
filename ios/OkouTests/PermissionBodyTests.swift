import ChatDataTestSupport
import Foundation
import Textual
import XCTest

@testable import Okou

@MainActor
final class PermissionBodyTests: XCTestCase {
  private let webURL = URL(string: "https://app.okou.ai")!
  private var link: String { "https://app.okou.ai" + PermissionHTTPFixture.actionURL() }

  func testPermissionSlotsReuseTheMessageParserAndPreserveAttributedProse() async throws {
    let blocks = await blocks(
      "**Before** [review **permission**](\(link)) *after*.\n\nOrdinary [link](https://example.com)."
    )
    XCTAssertEqual(blocks.filter { if case .permission = $0 { true } else { false } }.count, 1)
    let prose = blocks.compactMap { if case .markdown(let value) = $0 { value } else { nil } }
    XCTAssertTrue(
      prose.contains {
        $0.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true }
      })
    XCTAssertTrue(
      prose.contains {
        $0.runs.contains { $0.inlinePresentationIntent?.contains(.emphasized) == true }
      })
    XCTAssertTrue(prose.contains { $0.runs.contains { $0.link?.host == "example.com" } })
    let raw = await self.blocks(PermissionHTTPFixture.actionURL())
    XCTAssertTrue(raw.contains { if case .permission = $0 { true } else { false } })
    let paragraph = await self.blocks(
      "Ordinary **Markdown** and a [link](https://example.com).\n\n"
        + PermissionHTTPFixture.actionURL() + "\n\nAfter the request.")
    XCTAssertEqual(paragraph.filter { if case .permission = $0 { true } else { false } }.count, 1)
  }

  func testCodeTablesImagesAndUntrustedTargetsDoNotBecomePermissionRequests() async throws {
    for source in [
      "`\(link)`", "```text\n\(link)\n```", "    \(link)",
      "| Permission | Action |\n| --- | --- |\n| Gmail | [review](\(link)) |",
      "![request](\(link))", "[\(link)](https://evil.invalid)",
      "//evil.invalid" + PermissionHTTPFixture.actionURL(),
      "prefix" + PermissionHTTPFixture.actionURL(),
      "<a href=\"\(link)\">Review permission</a>",
      "<a title='>' href='\(link)'>Review permission</a>",
      "[review](\(link.replacingOccurrences(of: "app.okou.ai", with: "evil.invalid")))",
    ] {
      let result = await blocks(source)
      XCTAssertFalse(result.contains { if case .permission = $0 { true } else { false } }, source)
      guard case .markdown(let value) = result.first else {
        return XCTFail("Expected original Markdown")
      }
      let expected = await MessageMarkdownCache(baseURL: webURL).content(for: source)
      XCTAssertEqual(value, expected)
    }
  }

  func testMismatchedThreadAndAgentProduceAnInertPermissionSlot() async {
    for invalid in [
      link.replacingOccurrences(of: PermissionHTTPFixture.threadID, with: UUID().uuidString),
      link.replacingOccurrences(of: PermissionHTTPFixture.agentID, with: UUID().uuidString),
    ] {
      let result = await blocks("[Review permission](\(invalid))")
      XCTAssertTrue(result.contains { if case .unavailablePermission = $0 { true } else { false } })
      XCTAssertFalse(result.contains { if case .permission = $0 { true } else { false } })
    }
  }

  private func blocks(_ source: String) async -> [MessageActionBody.Block] {
    let content = await MessageMarkdownCache(baseURL: webURL).content(for: source)
    return MessageActionBody.blocks(
      content, webURL: webURL,
      agentID: PermissionHTTPFixture.agentID, threadID: PermissionHTTPFixture.threadID)
  }
}
