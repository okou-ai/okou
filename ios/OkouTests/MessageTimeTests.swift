import Foundation
import XCTest

@testable import Okou

@MainActor
final class MessageTimeTests: XCTestCase {
  func testTheSameMessageDisplaysTheInstantInTheReadersLocaleAndZone() async throws {
    let link = try XCTUnwrap(URL(string: "https://example.invalid/schedule"))
    let markdown = MessageMarkdownCache(baseURL: link)
    let source = """
      下次检查：**[<time datetime="2026-11-26T09:00:00.799+08:00">11 月 26 日 09:00</time>](\(link))**。
      """
    let content = await markdown.content(for: source)
    let instant = try Date("2026-11-26T01:00:00Z", strategy: .iso8601)
    for (region, zone) in [
      ("zh_CN", "Asia/Shanghai"), ("en_US", "America/Los_Angeles"),
      ("en-US-u-hc-h23", "America/Los_Angeles")
    ] {
      let locale = Locale(identifier: region)
      let timeZone = try XCTUnwrap(TimeZone(identifier: zone))
      let parser = PreparedMessageParser(
        content: content, timeFormat: MessageTime.format(locale: locale, timeZone: timeZone))
      let rendered = try parser.attributedString(for: source)
      let expected = Date.FormatStyle(locale: locale, timeZone: timeZone)
        .year().month(.abbreviated).day().hour().minute(.twoDigits).second(.twoDigits).timeZone(
          .specificName(.short))
      XCTAssertEqual(String(rendered.characters), "下次检查：\(instant.formatted(expected))。")
      let linked = try XCTUnwrap(rendered.runs.first { $0.link == link })
      XCTAssertEqual(String(rendered[linked.range].characters), instant.formatted(expected))
      XCTAssertEqual(linked.inlinePresentationIntent?.contains(.stronglyEmphasized), true)
    }
  }

  func testNonInstantsKeepTheirLabelsAndCodeKeepsTheLiteralMarkup() async throws {
    let markdown = MessageMarkdownCache(
      baseURL: try XCTUnwrap(URL(string: "https://example.invalid")))
    let example = #"<time datetime="2026-11-26T01:00:00Z">example</time>"#
    let source = """
      <time>missing</time> / <time datetime='2026-02-30T01:00:00Z'>invalid</time> / <time datetime="2026-11-26T09:00:00">*local*</time>

      Inline: `\(example)`

      ```html
      \(example)
      ```
      """
    let parser = PreparedMessageParser(content: await markdown.content(for: source))
    let rendered = try parser.attributedString(for: source)
    let text = String(rendered.characters)
    XCTAssertTrue(text.hasPrefix("missing / invalid / local"))
    XCTAssertEqual(text.components(separatedBy: example).count, 3)
    let emphasized = try XCTUnwrap(
      rendered.runs.first { $0.inlinePresentationIntent?.contains(.emphasized) == true })
    XCTAssertEqual(String(rendered[emphasized.range].characters), "local")
  }
}
