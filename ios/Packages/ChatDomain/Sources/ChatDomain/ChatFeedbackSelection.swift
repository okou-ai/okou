import Foundation

/// A snapshot of the actual native selection in one assistant event's visible text.
public struct ChatFeedbackSelection: Equatable, Sendable {
  public let eventID: String
  public let text: String
  public let quote: String
  public let range: NSRange

  public init?(message: ChatMessage, range: NSRange) {
    guard message.role == .assistant, !message.isError, !message.isQueued,
      !message.id.isEmpty, range.location != NSNotFound, range.length > 0,
      range.location >= 0, range.location <= message.text.utf16.count,
      range.length <= message.text.utf16.count - range.location,
      let selected = Range(range, in: message.text)
    else { return nil }
    let passage = String(message.text[selected])
    guard passage.utf16.count == range.length,
      String(message.text[..<selected.lowerBound]).utf16.count == range.location
    else { return nil }
    let quote = passage.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !quote.isEmpty else { return nil }
    // trimStart separately: trailing whitespace must not shift the start.
    let trimmedStart = passage.unicodeScalars.drop(while: {
      CharacterSet.whitespacesAndNewlines.contains($0)
    })
    let start =
      range.location + passage.utf16.count
      - String(String.UnicodeScalarView(trimmedStart)).utf16.count
    self.eventID = message.id
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
