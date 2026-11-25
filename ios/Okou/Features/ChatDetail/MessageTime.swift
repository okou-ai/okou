import Foundation

/// The cache retains the instant. The native text renderer formats it for the reading device.
enum MessageTime: AttributedStringKey {
  struct Value: Hashable, Sendable {
    let date: Date
    // Adjacent equal instants are still two elements when Foundation coalesces runs.
    let element: Int
  }

  static let name = "ai.okou.message-time"

  static func recognizingElements(in content: AttributedString, source: String) -> AttributedString
  {
    var opening: (run: AttributedString.Runs.Run, date: Date?)?
    var result = AttributedString()
    var cursor = content.startIndex

    for (element, run) in content.runs.enumerated() {
      let characters = content[run.range].characters
      guard characters.first == "<" else { continue }
      let tag = String(characters)
      if run.inlinePresentationIntent?.contains(.inlineHTML) != true {
        // Foundation can replace the HTML intent with the enclosing emphasis or link.
        // Recover only a literal source node, never an escape or a code example.
        guard let position = run.markdownSourcePosition, let range = Range(position, in: source),
          source[range] == tag, run.inlinePresentationIntent?.contains(.code) != true,
          run.presentationIntent?.components.contains(where: {
            if case .codeBlock = $0.kind { return true }
            return false
          }) != true
        else { continue }
      }
      if tag.prefixMatch(of: #/(?i)<time(?=[\s>])/#) != nil {
        opening = (run, instant(in: tag))
      } else if tag.wholeMatch(of: #/(?i)</time\s*>/#) != nil, let start = opening {
        opening = nil
        guard start.run.presentationIntent == run.presentationIntent else { continue }
        result.append(content[cursor..<start.run.range.lowerBound])
        if let date = start.date {
          var attributes = start.run.attributes
          attributes.inlinePresentationIntent?.remove(.inlineHTML)
          attributes[Self.self] = Value(date: date, element: element)
          // Artifact titles also read these characters as plain text.
          let text = date.formatted(format(locale: .current, timeZone: .current))
          result.append(AttributedString(text, attributes: attributes))
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
