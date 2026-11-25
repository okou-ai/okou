import Foundation

/// The cache retains the instant. The native text renderer formats it for the reading device.
enum MessageTime: AttributedStringKey {
  struct Value: Hashable, Sendable {
    let date: Date
    // Adjacent equal instants are still two elements when Foundation coalesces runs.
    let element: Int
  }

  static let name = "ai.okou.message-time"

  static func recognizingElements(
    in content: AttributedString, source: String
  ) -> AttributedString {
    var opening: (range: Range<AttributedString.Index>, date: Date?)?
    var result = AttributedString()
    var cursor = content.startIndex

    for (element, range) in htmlRanges(in: content, source: source).enumerated() {
      let tag = String(content[range].characters)
      if tag.prefixMatch(of: #/(?i)<time(?=[\s>])/#) != nil {
        opening = (range, instant(in: tag))
      } else if tag.wholeMatch(of: #/(?i)</time\s*>/#) != nil, let start = opening {
        opening = nil
        let run = content.runs[start.range.lowerBound]
        guard run.presentationIntent == content.runs[range.lowerBound].presentationIntent else {
          continue
        }
        result.append(content[cursor..<start.range.lowerBound])
        if let date = start.date {
          var attributes = run.attributes
          attributes.inlinePresentationIntent?.remove(.inlineHTML)
          attributes[Self.self] = Value(date: date, element: element)
          // Artifact titles also read these characters as plain text.
          let text = date.formatted(format(locale: .current, timeZone: .current))
          result.append(AttributedString(text, attributes: attributes))
        } else {
          result.append(content[start.range.upperBound..<range.lowerBound])
        }
        cursor = range.upperBound
      }
    }
    guard cursor != content.startIndex else { return content }
    result.append(content[cursor...])
    return result
  }

  private static func htmlRanges(
    in content: AttributedString, source: String
  ) -> [Range<AttributedString.Index>] {
    var ranges: [Range<AttributedString.Index>] = []
    for run in content.runs {
      if run.inlinePresentationIntent?.contains(.inlineHTML) == true {
        ranges.append(run.range)
        continue
      }
      // Foundation can collapse a formatted link label into a single run. Parse its
      // original Markdown to recover HTML boundaries without interpreting escaped or code text.
      guard run.link != nil || run.inlinePresentationIntent?.isEmpty == false,
        run.inlinePresentationIntent?.contains(.code) != true,
        run.inlinePresentationIntent?.contains(.blockHTML) != true,
        content[run.range].characters.contains("<"),
        let position = run.markdownSourcePosition, let sourceRange = Range(position, in: source),
        let label = try? AttributedString(
          markdown: String(source[sourceRange]),
          options: .init(appliesSourcePositionAttributes: true)),
        label.characters.elementsEqual(content[run.range].characters)
      else { continue }
      var cursor = run.range.lowerBound
      for child in label.runs {
        let end = content.characters.index(cursor, offsetBy: label[child.range].characters.count)
        if child.inlinePresentationIntent?.contains(.inlineHTML) == true {
          ranges.append(cursor..<end)
        }
        cursor = end
      }
    }
    return ranges
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
    for (time, range) in content.runs[Self.self] {
      guard let time else { continue }
      result.append(content[cursor..<range.lowerBound])
      var attributes = content.runs[range.lowerBound].attributes
      attributes[Self.self] = nil
      result.append(AttributedString(time.date.formatted(format), attributes: attributes))
      cursor = range.upperBound
    }
    guard cursor != content.startIndex else { return content }
    result.append(content[cursor...])
    return result
  }
}
