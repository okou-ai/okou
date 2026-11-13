import Foundation

/// The visible message group is the selection and counting unit on both clients.
public struct ChatShareGroup: Equatable, Identifiable, Sendable {
  public let id: String
  public let messages: [ChatMessage]
  public init(id: String, messages: [ChatMessage]) {
    self.id = id
    self.messages = messages
  }

  public var eventIDs: [String] { messages.map(\.id) }
  public var textBytes: Int { messages.reduce(0) { $0 + Self.shareText($1).utf8.count } }

  public static func groups(in history: ChatHistory) -> [ChatShareGroup] {
    displayGroups(in: history).compactMap { group in
      let messages: [ChatMessage]
      if group.first?.role == .user {
        messages = group.filter { !$0.isError && !shareText($0).isEmpty }
      } else {
        messages = group.last(where: { $0.role == .assistant }).map { [$0] } ?? []
      }
      guard let first = group.first, !messages.isEmpty else { return nil }
      return ChatShareGroup(id: first.id, messages: messages)
    }
  }

  /// A quick share includes the preceding user group and the chosen persisted answer.
  public static func answerEventIDs(_ answerID: String, in history: ChatHistory) -> [String] {
    let groups = displayGroups(in: history)
    guard let index = groups.firstIndex(where: { $0.contains { $0.id == answerID } }),
      groups[index].contains(where: { $0.id == answerID && $0.role == .assistant })
    else { return [] }
    let prompts = groups[..<index].last(where: { $0.first?.role == .user }) ?? []
    return prompts.filter { !$0.isError }.map(\.id) + [answerID]
  }

  private static func displayGroups(in history: ChatHistory) -> [[ChatMessage]] {
    let hidden = Set(history.workSections.flatMap(\.hiddenMessageIDs))
    let anchors = Set(history.workSections.map(\.anchorMessageID))
    var groups: [[ChatMessage]] = []
    var lastHoldsAnchor = false
    for message in history.messages
    where history.persistedEventIDs.contains(message.id) && !message.isQueued
      && !hidden.contains(message.id)
    {
      let isAnchor = anchors.contains(message.id)
      let isUser = message.role == .user
      let forceStandalone = isAnchor || (message.runID == nil && lastHoldsAnchor)
      if !forceStandalone, let last = groups.last, (last.first?.role == .user) == isUser {
        groups[groups.count - 1].append(message)
      } else {
        groups.append([message])
        lastHoldsAnchor = isAnchor
      }
    }
    return groups
  }

  private static func shareText(_ message: ChatMessage) -> String {
    guard message.role == .user else { return message.text }
    let text = message.copyText.trimmingCharacters(in: .whitespacesAndNewlines)
    if !text.isEmpty { return text }
    guard let automation = message.userMessage?.annotation, automation.type == "automation" else {
      return ""
    }
    let brief = automation.automationBrief?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return brief.isEmpty
      ? automation.workflowName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "" : brief
  }
}
