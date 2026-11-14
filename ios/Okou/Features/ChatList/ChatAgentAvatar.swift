import CCStateSwiftUI
import ChatData
import ChatDomain
import SwiftUI

/// Read identity inside the hosted row so metadata updates refresh existing cells.
struct ChatAgentAvatar: View {
  let agents: ThreadListStore?
  let agentID: String
  var size: CGFloat = OkouAvatarSize.message

  var body: some View {
    if let agents {
      StoreProvider(agents.stateStore) {
        ChatAgentAvatarContent(agents: agents, agentID: agentID, size: size)
          .id(ObjectIdentifier(agents))
      }
    } else {
      OkouAgentAvatar(avatarURL: nil, name: "Agent", isDefault: false, size: size)
    }
  }
}

private struct ChatAgentAvatarContent: View {
  let agents: ThreadListStore
  let agentID: String
  let size: CGFloat
  @ResolvedValue private var current: [AgentRecord]?

  init(agents: ThreadListStore, agentID: String, size: CGFloat) {
    self.agents = agents
    self.agentID = agentID
    self.size = size
    _current = ResolvedValue(task: agents.navigationValue)
  }

  var body: some View {
    let agent = (current ?? agents.agents).first(where: { $0.agentId == agentID })
    OkouAgentAvatar(
      avatarURL: agent?.avatarUrl, name: agent?.displayName ?? "Agent",
      isDefault: agent?.isDefaultAgent ?? false, size: size)
  }
}

extension ChatThread {
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
