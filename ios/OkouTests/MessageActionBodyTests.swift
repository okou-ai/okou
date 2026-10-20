import ChatDataTestSupport
import Foundation
import Textual
import XCTest

@testable import Okou

@MainActor
final class MessageActionBodyTests: XCTestCase {
  private let webURL = URL(string: "https://app.example.invalid")!
  private var link: String {
    "https://app.example.invalid/connectors/slack/connect?agentId=\(ConnectorHTTPFixtures.agentID)&threadId=\(ConnectorHTTPFixtures.threadID)&callbackPrompt=Continue"
  }
  private func blocks(_ source: String) async -> [MessageActionBody.Block] {
    let markdown = MessageMarkdownCache(baseURL: webURL)
    let content = await markdown.content(for: source)
    return MessageActionBody.blocks(
      content, webURL: webURL, agentID: ConnectorHTTPFixtures.agentID,
      threadID: ConnectorHTTPFixtures.threadID)
  }
  func testCardSlotsRecognizeLinksAndRawURLsWithoutLosingSurroundingAttributes() async throws {
    let source = "**Before** [connect **Slack** account](\(link)) *after*.\n\nPlain text."
    let parsed = await blocks(source)
    XCTAssertEqual(parsed.filter { if case .connector = $0 { true } else { false } }.count, 1)
    let prose = parsed.compactMap { if case .markdown(let content) = $0 { content } else { nil } }
    XCTAssertTrue(
      prose.contains {
        String($0.characters).contains("Before")
          && $0.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true }
      })
    XCTAssertTrue(
      prose.contains {
        String($0.characters).contains("after")
          && $0.runs.contains { $0.inlinePresentationIntent?.contains(.emphasized) == true }
      })
    let raw = await blocks("Use this service:\n\n\(link)")
    XCTAssertEqual(raw.filter { if case .connector = $0 { true } else { false } }.count, 1)
  }
  func testCodeTablesImagesAndForeignLinksRemainOrdinaryMarkdown() async throws {
    for source in [
      "`\(link)`", "```text\n\(link)\n```", "    \(link)",
      "| Service | Action |\n| --- | --- |\n| Slack | [connect](\(link)) |",
      "![\(link)](/image.png)",
      "[\(link)](https://evil.invalid)",
      "[external](\(link.replacingOccurrences(of: "app.example.invalid", with: "evil.invalid")))",
    ] {
      let result = await blocks(source)
      XCTAssertFalse(result.contains { if case .connector = $0 { true } else { false } }, source)
      let expected = await MessageMarkdownCache(baseURL: webURL).content(for: source)
      guard case .markdown(let actual) = result.first else { return XCTFail("Expected Markdown") }
      XCTAssertEqual(actual, expected)
    }
  }
  func testMismatchedChatRendersUnavailableActionInsteadOfAnOperableLink() async {
    let result = await blocks(
      "[Connect](\(link.replacingOccurrences(of: ConnectorHTTPFixtures.threadID, with: ConnectorHTTPFixtures.siblingID)))"
    )
    guard case .connector(let action) = result.first else {
      return XCTFail("Expected unavailable slot")
    }
    XCTAssertEqual(action.kind, .unavailable)
  }
}
