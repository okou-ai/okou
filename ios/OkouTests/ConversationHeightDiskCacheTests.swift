import Foundation
import XCTest

@testable import Okou

final class ConversationHeightDiskCacheTests: XCTestCase {
  func testReopenedCacheReusesOnlyMatchingLayoutsAndScopes() async throws {
    let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: file) }
    let original = key()
    let writer = ConversationHeightDiskCache(file: file)
    await writer.store([original: 42.5])

    let reader = ConversationHeightDiskCache(file: file)
    let restored = await reader.heights(for: [
      "matching": original,
      "edited": key(text: "Edited"),
      "resized": key(width: 500),
      "anotherThread": key(namespace: ["another-thread"]),
    ])
    XCTAssertEqual(restored, ["matching": 42.5])

    await reader.store([original: 50])
    let updated = await writer.heights(for: ["matching": original])
    XCTAssertEqual(updated, ["matching": 50])
  }

  func testKeepsRecentMeasurementsWithinTheFileLimit() async throws {
    let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: file) }
    let cache = ConversationHeightDiskCache(file: file, limit: 1)
    let first = key()
    let second = key(text: "Later")
    await cache.store([first: 24])
    await cache.store([second: 48])

    let reader = ConversationHeightDiskCache(file: file)
    let heights = await reader.heights(for: ["first": first, "second": second])
    XCTAssertEqual(heights, ["second": 48])
  }

  private func key(
    text: String = "Message", width: Double = 320, namespace: [String] = ["thread"]
  ) -> ConversationHeightDiskCache.Key {
    ConversationHeightDiskCache.Key(
      namespace: namespace, id: "message", text: text, role: "assistant", showsAvatar: true,
      spacing: 24, workHistory: false,
      layout: .init(
        width: width, scale: 3, category: "large", direction: 0, legibility: 0, style: 1,
        locale: "en", renderer: "1"))
  }
}
