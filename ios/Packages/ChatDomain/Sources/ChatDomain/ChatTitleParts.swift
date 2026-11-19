import Foundation

/// A chat title's status emoji (the web's ✅ Done, ⏳ Waiting, …) split from its text,
/// matching the web's first-emoji rule so every client and the widgets agree on the same title.
public struct ChatTitleParts: Equatable, Sendable {
  public let emoji: String?
  public let text: String

  public init(_ title: String) {
    let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let index = trimmed.firstIndex(where: \.isTitleEmoji) else {
      emoji = nil
      text = trimmed
      return
    }
    let before = trimmed[..<index].trimmingCharacters(in: .whitespaces)
    let after = trimmed[trimmed.index(after: index)...].trimmingCharacters(in: .whitespaces)
    let joined = [before, after].filter { !$0.isEmpty }.joined(separator: " ")
    emoji = String(trimmed[index])
    text = joined.isEmpty ? String(trimmed[index]) : joined
  }
}

extension ChatThread {
  public var titleParts: ChatTitleParts { ChatTitleParts(displayTitle) }
}

extension Character {
  fileprivate var isTitleEmoji: Bool {
    guard let scalar = unicodeScalars.first else { return false }
    if scalar.properties.isEmojiPresentation { return true }
    // Text-default pictographs count when they carry a variation selector or a sequence.
    return scalar.properties.isEmoji && unicodeScalars.count > 1 && !isNumber
      && scalar != "#" && scalar != "*"
  }
}
