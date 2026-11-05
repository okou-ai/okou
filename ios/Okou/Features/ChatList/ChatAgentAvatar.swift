import ChatDomain
import SwiftUI

/// Read identity inside the hosted row so metadata updates refresh existing cells.
struct ChatAgentAvatar: View {
  let agents: ThreadListStore?
  let agentID: String
  var size: CGFloat = OkouAvatarSize.message

  var body: some View {
    let agent = agents?.agents.first(where: { $0.agentId == agentID })
    OkouAgentAvatar(
      avatarURL: agent?.avatarUrl, name: agent?.displayName ?? "Agent",
      isDefault: agent?.isDefaultAgent ?? false, size: size)
  }
}

extension ChatThread {
  /// The title's status emoji (the web's ✅ Done, ⏳ Waiting, …) split from its text,
  /// matching the web's first-emoji rule so both clients agree on the same title.
  var titleParts: (emoji: String?, text: String) {
    let trimmed = displayTitle.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let index = trimmed.firstIndex(where: \.isTitleEmoji) else { return (nil, trimmed) }
    let before = trimmed[..<index].trimmingCharacters(in: .whitespaces)
    let after = trimmed[trimmed.index(after: index)...].trimmingCharacters(in: .whitespaces)
    let text = [before, after].filter { !$0.isEmpty }.joined(separator: " ")
    return (String(trimmed[index]), text.isEmpty ? String(trimmed[index]) : text)
  }

  /// The title with `emoji` as its status, replacing any existing one; nil clears it.
  func title(withStatus emoji: String?) -> String {
    let parts = titleParts
    // An emoji-only title has no text to keep.
    let text = parts.emoji == nil ? displayTitle : (parts.text == parts.emoji ? "" : parts.text)
    guard let emoji else { return text }
    return text.isEmpty ? emoji : "\(emoji) \(text)"
  }
}

/// The status choices the web offers for a chat title.
enum ChatThreadStatus: String, CaseIterable, Identifiable {
  case done = "✅"
  case urgent = "🔥"
  case no = "❌"
  case risk = "⚠️"
  case idea = "💡"
  case question = "❓"
  case waiting = "⏳"
  case watching = "👀"
  case shipped = "🚀"

  var id: String { rawValue }

  var label: String {
    switch self {
    case .done: String(localized: "Done")
    case .urgent: String(localized: "Urgent")
    case .no: String(localized: "No")
    case .risk: String(localized: "Risk")
    case .idea: String(localized: "Idea")
    case .question: String(localized: "Question")
    case .waiting: String(localized: "Waiting")
    case .watching: String(localized: "Watching")
    case .shipped: String(localized: "Shipped")
    }
  }
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
