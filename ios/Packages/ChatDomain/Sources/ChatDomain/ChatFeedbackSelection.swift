import Foundation

/// A snapshot of the actual native selection in one assistant event's visible text.
public struct ChatFeedbackSelection: Equatable, Sendable {
  public let eventID: String
  public let text: String
  public let quote: String
  public let range: NSRange

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
    let quote = passage.trimmingCharacters(in: .ecmaScriptWhitespace)
    guard !quote.isEmpty else { return nil }
    // trimStart separately: trailing whitespace must not shift the start.
    let trimmedStart = passage.unicodeScalars.drop(while: {
      CharacterSet.ecmaScriptWhitespace.contains($0)
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
        "end": .number(Decimal(range.location + range.length))
      ])
    ])
  }
}
