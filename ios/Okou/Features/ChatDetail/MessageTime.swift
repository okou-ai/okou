import Foundation

/// The cache retains the instant. The native text renderer formats it for the reading device.
enum MessageTime: AttributedStringKey {
  typealias Value = Date
  static let name = "ai.okou.message-time"

  static func recognizingElements(in content: AttributedString) -> AttributedString {
    var opening: (run: AttributedString.Runs.Run, date: Date?)?
    var result = AttributedString()
    var cursor = content.startIndex

    // Source positions keep adjacent HTML nodes distinct. Code and escaped tags are plain
    // Markdown content and never enter this loop.
    for run in content.runs where run.inlinePresentationIntent?.contains(.inlineHTML) == true {
      let tag = String(content[run.range].characters)
      if tag.prefixMatch(of: #/(?i)<time(?=[\s>])/#) != nil {
        opening = (run, instant(in: tag))
      } else if tag.wholeMatch(of: #/(?i)</time\s*>/#) != nil, let start = opening {
        opening = nil
        guard start.run.presentationIntent == run.presentationIntent else { continue }
        result.append(content[cursor..<start.run.range.lowerBound])
        if let date = start.date {
          var attributes = start.run.attributes
          attributes.inlinePresentationIntent?.remove(.inlineHTML)
          attributes[Self.self] = date
          result.append(AttributedString("\u{fffc}", attributes: attributes))
        } else {
          result.append(content[start.run.range.upperBound..<run.range.lowerBound])
        }
        cursor = run.range.upperBound
      }
    }
    guard cursor != content.startIndex else { return content }
    result.append(content[cursor...])
    return result
  }

  private static func instant(in tag: String) -> Date? {
    let attribute = #/\s+([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/#
    for match in tag.matches(of: attribute) where match.1.lowercased() == "datetime" {
      guard let value = match.2 ?? match.3 ?? match.4 else { return nil }
      // An absolute instant requires an explicit offset. The strict calendar parser also
      // rejects impossible dates rather than rolling them into the next month.
      let timestamp =
        #/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?(?:Z|[+-][0-9]{2}:[0-9]{2})/#
      guard let parts = value.wholeMatch(of: timestamp) else { return nil }
      let parser = DateFormatter()
      parser.locale = Locale(identifier: "en_US_POSIX")
      parser.dateFormat =
        "yyyy-MM-dd'T'HH:mm" + (parts.1 == nil ? "" : ":ss") + (parts.2 == nil ? "" : ".SSS")
        + "XXXXX"
      return parser.date(from: String(value))
    }
    return nil
  }

  static func format(locale: Locale, timeZone: TimeZone) -> Date.FormatStyle {
    Date.FormatStyle(date: .abbreviated, time: .standard, locale: locale, timeZone: timeZone)
      .timeZone(.specificName(.short))
  }

  static func localized(_ content: AttributedString, format: Date.FormatStyle) -> AttributedString {
    var result = AttributedString()
    var cursor = content.startIndex
    for run in content.runs {
      guard let date = run[Self.self] else { continue }
      result.append(content[cursor..<run.range.lowerBound])
      // Adjacent identical timestamps can coalesce into one attributed run.
      let text = String(
        repeating: date.formatted(format), count: content[run.range].characters.count)
      var attributes = run.attributes
      attributes[Self.self] = nil
      result.append(AttributedString(text, attributes: attributes))
      cursor = run.range.upperBound
    }
    guard cursor != content.startIndex else { return content }
    result.append(content[cursor...])
    return result
  }
}
