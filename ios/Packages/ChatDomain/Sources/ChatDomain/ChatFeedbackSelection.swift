import Foundation

/// A snapshot of the actual native selection in one assistant event's visible text.
public struct ChatFeedbackSelection: Equatable, Sendable {
  public let eventID: String
  public let text: String
  public let quote: String
  public let range: NSRange

  // ECMAScript String.trim whitespace, matching the PWA selection snapshot.
  private static let whitespace = CharacterSet(
    charactersIn:
      "\u{0009}\u{000A}\u{000B}\u{000C}\u{000D}\u{0020}\u{00A0}\u{1680}"
      + "\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}"
      + "\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}")

  public init?(message: ChatMessage, range: NSRange, visibleText: String? = nil) {
    let visibleText = visibleText ?? message.text
    guard message.role == .assistant, !message.isError, !message.isQueued,
      !message.id.isEmpty, range.location != NSNotFound, range.length > 0,
      range.location >= 0, range.location <= visibleText.utf16.count,
      range.length <= visibleText.utf16.count - range.location,
      let selected = Range(range, in: visibleText)
    else { return nil }
    let passage = String(visibleText[selected])
    guard passage.utf16.count == range.length,
      String(visibleText[..<selected.lowerBound]).utf16.count == range.location
    else { return nil }
    let quote = passage.trimmingCharacters(in: Self.whitespace)
    guard !quote.isEmpty else { return nil }
    // trimStart separately: trailing whitespace must not shift the start.
    let trimmedStart = passage.unicodeScalars.drop(while: {
      Self.whitespace.contains($0)
    })
    let start =
      range.location + passage.utf16.count
      - String(String.UnicodeScalarView(trimmedStart)).utf16.count
    self.eventID = message.id
    // Retain the source snapshot for stale-event validation; offsets describe rendered text.
    self.text = message.text
    self.quote = quote
    self.range = NSRange(location: start, length: quote.utf16.count)
  }

  public var part: MessageJSON {
    .object([
      "type": .string("feedback"), "quote": .string(quote), "note": .array([]),
      "eventId": .string(eventID),
      "range": .object([
        "start": .number(Decimal(range.location)),
        "end": .number(Decimal(range.location + range.length)),
      ]),
    ])
  }
}
