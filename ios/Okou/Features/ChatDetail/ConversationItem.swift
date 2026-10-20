import ChatDomain

/// Stable native rows keep work controls and individual messages independently reusable.
enum ConversationItem: Equatable, Identifiable {
  case message(ChatMessage, isWorkHistory: Bool = false)
  case work(ChatWorkSection, expanded: Bool)
  case usage(runID: String)

  var id: String {
    switch self {
    case .message(let message, _): message.id
    case .work(let section, _): section.id
    case .usage(let runID): "usage:\(runID)"
    }
  }

  var message: ChatMessage? {
    if case .message(let message, _) = self { return message }
    return nil
  }

  var role: ChatMessage.Role {
    switch self {
    case .message(let message, _): message.role == .system ? .assistant : message.role
    case .work, .usage: .assistant
    }
  }

  var beginsWorkSection: Bool {
    if case .work = self { return true }
    return false
  }
}
