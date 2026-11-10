import ChatData
import ChatDomain
import SwiftUI

/// Workspace chat references, independent of the sidebar's current filter.
struct ComposerMentionSource: Equatable {
  let agentID: String?
  let threads: [ChatThread]

  func suggestions(for query: String) -> [ComposerMentionSuggestion] {
    guard agentID != nil else { return [] }
    let query = query.lowercased()
    // The PWA reducer orders pinned chats first, then activity and ID; it does
    // not apply the sidebar's fractional pin ranking to mention suggestions.
    return ChatThreadReplay.replay(snapshot: threads, events: []).filter {
      !$0.title.isEmpty && (query.isEmpty || $0.title.lowercased().contains(query))
    }.prefix(25).map { thread in
      ComposerMentionSuggestion(referenceID: thread.id, title: thread.title)
    }
  }
}

struct ComposerMentionSuggestion: Equatable, Identifiable {
  let referenceID: String
  let title: String
  var id: String { "chat-\(referenceID)" }
  var part: MessageJSON {
    .object([
      "type": .string("chat_thread"), "threadId": .string(referenceID),
      "titleSnapshot": .string(title),
    ])
  }
}

struct ComposerMentionMenu: View {
  let editor: ComposerEditor
  let availableHeight: CGFloat

  var body: some View {
    let suggestions = editor.mentionSuggestions
    OkouSuggestionPanel(
      title: "Chats", availableHeight: availableHeight,
      dismissLabel: "Dismiss chat suggestions", dismissIdentifier: "dismiss-mentions",
      dismiss: editor.dismissMentions
    ) { height in
      if suggestions.isEmpty {
        Text("No matching chats")
          .font(.okou(.subheadline)).foregroundStyle(OkouColor.mutedForeground)
          .padding(OkouSpace.lg)
      } else {
        ComposerSuggestionTable(
          items: suggestions.map {
            ComposerSuggestionItem(
              id: "mention-" + $0.id, title: $0.title,
              accessibilityLabel: String(localized: "Chat: \($0.title)"),
              accessibilityHint: String(localized: "Inserts this chat into your message"))
          },
          selectedIndex: editor.selectedMentionIndex,
          maximumHeight: min(OkouControl.suggestionListHeight, height),
          accessibilityIdentifier: "mention-suggestions",
          activate: { id in
            guard let suggestion = suggestions.first(where: { "mention-" + $0.id == id }) else {
              return
            }
            editor.insertMention(suggestion)
          }
        )
        .id(editor.mentionQuery)
      }
    }
    .accessibilityIdentifier("mention-menu")
  }
}
