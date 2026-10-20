import Foundation

/// The canonical workspace search response. Sequence IDs identify hits, not rendered row IDs.
public struct ChatSearchResult: Decodable, Identifiable, Sendable {
  public let chatThreadId: String
  public let agentName: String
  public let matchedMessage: Message
  public let matchedRanges: [MatchRange]
  public var id: String { "\(matchedMessage.chatThreadId):\(matchedMessage.seqId)" }

  public struct Message: Decodable, Sendable {
    public let chatThreadId: String
    public let role: String
    public let content: String
    public let createdAt: Date
    public let seqId: Int
    public let runId: String?
  }

  public struct MatchRange: Decodable, Sendable {
    public let start: Int
    public let end: Int
  }

  /// PWA's 140 UTF-16-unit context around the first hit, without splitting a surrogate pair.
  public var snippet: AttributedString {
    let content = matchedMessage.content as NSString
    let ranges = matchedRanges.filter {
      $0.start >= 0 && $0.end > $0.start && $0.end <= content.length
    }
    let first = ranges.first
    let context = max(0, 140 - ((first?.end ?? 0) - (first?.start ?? 0)))
    var start = max(0, (first?.start ?? 0) - context / 2)
    var end = min(content.length, start + 140)
    start = max(0, end - 140)
    if start > 0, start < content.length, (0xDC00...0xDFFF).contains(content.character(at: start)) {
      start -= 1
    }
    if end > 0, end < content.length, (0xD800...0xDBFF).contains(content.character(at: end - 1)) {
      end += 1
    }
    let text = content.substring(with: NSRange(location: start, length: end - start))
    var attributed = AttributedString(text)
    for range in ranges {
      let lower = max(start, range.start) - start
      let upper = min(end, range.end) - start
      guard lower < upper,
        let swiftRange = Range(NSRange(location: lower, length: upper - lower), in: text),
        let attributedRange = Range(swiftRange, in: attributed)
      else { continue }
      attributed[attributedRange].inlinePresentationIntent = .stronglyEmphasized
    }
    return AttributedString("… ") + attributed + AttributedString(" …")
  }
}
