import Foundation
import Textual
import XCTest

@testable import Okou

@MainActor
final class MessageMarkdownTests: XCTestCase {
  func testPreparedContentPreservesPinnedRendererAttributes() async throws {
    let baseURL = URL(string: "https://app.example.invalid")!
    let markdown = MessageMarkdownCache(baseURL: baseURL)
    let source = """
      # 标题 👋

      **Bold** and *italic*, `inline code`, [a relative link](/chats).

      1. First
         - Nested

      > Quoted text

      | Feature | Result |
      | --- | --- |
      | Table | Preserved |

      ```swift
      print("hello")
      ```

      ![An image](/image.png)
      """
    let expected = try AttributedStringMarkdownParser(baseURL: baseURL).attributedString(
      for: source)
    let content = await markdown.content(for: source)
    XCTAssertEqual(content, expected)
    XCTAssertEqual(markdown.cached(source), expected)
    XCTAssertTrue(
      content.runs.contains { $0.link?.absoluteURL == baseURL.appending(path: "chats") })
    XCTAssertTrue(content.runs.contains { $0.imageURL != nil })
    XCTAssertTrue(content.runs.contains { $0.presentationIntent != nil })
  }

  func testCacheEvictsLeastRecentlyUsedContentAndDoesNotRetainOversizedMessages() async {
    let markdown = MessageMarkdownCache(
      baseURL: URL(string: "https://app.example.invalid")!, costLimit: 1024, entryLimit: 2)
    _ = await markdown.content(for: "First")
    _ = await markdown.content(for: "Second")
    XCTAssertNotNil(markdown.cached("First"))
    _ = await markdown.content(for: "Third")
    XCTAssertNotNil(markdown.cached("First"))
    XCTAssertNil(markdown.cached("Second"))
    XCTAssertNotNil(markdown.cached("Third"))

    let large = String(repeating: "Long message ", count: 200) + "End"
    let content = await markdown.content(for: large)
    XCTAssertEqual(String(content.characters), large)
    XCTAssertNil(markdown.cached(large))
    XCTAssertNotNil(markdown.cached("First"))
    markdown.clear()
    XCTAssertNil(markdown.cached("First"))
    XCTAssertNil(markdown.cached("Third"))
  }

  func testUpdatedContentAndWorkspaceBaseURLCannotReuseStaleRendering() async {
    let first = MessageMarkdownCache(baseURL: URL(string: "https://first.example.invalid")!)
    let second = MessageMarkdownCache(baseURL: URL(string: "https://second.example.invalid")!)
    let source = "[Chat](/chats)"
    async let firstResult = first.content(for: source)
    async let secondResult = second.content(for: source)
    let (firstContent, secondContent) = await (firstResult, secondResult)
    XCTAssertNotEqual(firstContent, secondContent)

    let updated = await first.content(for: "**Updated**")
    XCTAssertEqual(String(updated.characters), "Updated")
    XCTAssertEqual(first.cached(source), firstContent)
    XCTAssertEqual(first.cached("**Updated**"), updated)
  }
}
