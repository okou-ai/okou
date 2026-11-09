import ChatData
import ChatDomain
import SwiftUI

/// Workspace chat references, independent of the sidebar's current filter.
struct ComposerMentionSource: Equatable {
  let agentID: String?
  let agents: [AgentRecord]
  let threads: [ChatThread]

  func suggestions(for query: String) -> [ComposerMentionSuggestion] {
    guard agentID != nil else { return [] }
    let query = query.lowercased()
    // The PWA reducer orders pinned chats first, then activity and ID; it does
    // not apply the sidebar's fractional pin ranking to mention suggestions.
    let chats = ChatThreadReplay.replay(snapshot: threads, events: []).filter {
      !$0.title.isEmpty && (query.isEmpty || $0.title.lowercased().contains(query))
    }.prefix(25).map { thread in
      ComposerMentionSuggestion(
        referenceID: thread.id, title: thread.title,
        avatarURL: {
          let agent = agents.first(where: { $0.agentId == thread.agentID })
          return agent?.isDefaultAgent == true ? OkouAgentAvatar.defaultURL : agent?.avatarUrl
        }())
    }
    return chats
  }
}

struct ComposerMentionSuggestion: Equatable, Identifiable {
  let referenceID: String
  let title: String
  let avatarURL: String?
  var id: String { "chat-\(referenceID)" }
  var part: MessageJSON {
    .object([
      "type": .string("chat_thread"), "threadId": .string(referenceID),
      "titleSnapshot": .string(title),
    ])
  }
}

/// The table never becomes first responder. Selection belongs to the native text
/// view, including while scrolling or activating a row with VoiceOver.
struct ComposerMentionMenu: View {
  let editor: ComposerEditor
  let suggestions: [ComposerMentionSuggestion]

  var body: some View {
    ComposerMentionTable(
      editor: editor, suggestions: suggestions, selectedIndex: editor.selectedMentionIndex
    )
    .frame(height: min(260, CGFloat(suggestions.count) * 48 + 64))
    .modifier(OkouFloatingPanelStyle())
  }
}

private struct ComposerMentionTable: UIViewRepresentable {
  let editor: ComposerEditor
  let suggestions: [ComposerMentionSuggestion]
  let selectedIndex: Int

  func makeCoordinator() -> Coordinator { Coordinator() }
  func makeUIView(context: Context) -> UITableView {
    let table = UITableView(frame: .zero, style: .plain)
    table.backgroundColor = .clear
    table.separatorStyle = .none
    table.keyboardDismissMode = .none
    table.rowHeight = UITableView.automaticDimension
    table.estimatedRowHeight = 48
    table.sectionHeaderTopPadding = 0
    table.register(MentionCell.self, forCellReuseIdentifier: "mention")
    table.dataSource = context.coordinator
    table.delegate = context.coordinator
    table.accessibilityIdentifier = "mention-suggestions"
    return table
  }

  func updateUIView(_ table: UITableView, context: Context) {
    let coordinator = context.coordinator
    coordinator.editor = editor
    let changed = coordinator.suggestions != suggestions
    coordinator.suggestions = suggestions
    if changed { table.reloadData() }
    guard suggestions.indices.contains(selectedIndex) else { return }
    let path = IndexPath(row: selectedIndex, section: 0)
    table.selectRow(at: path, animated: false, scrollPosition: .none)
    if coordinator.selectedIndex != selectedIndex {
      table.scrollToRow(at: path, at: .none, animated: false)
    }
    coordinator.selectedIndex = selectedIndex
  }

  static func dismantleUIView(_ view: UITableView, coordinator: Coordinator) {
    coordinator.editor = nil
    view.delegate = nil
    view.dataSource = nil
  }

  final class Coordinator: NSObject, UITableViewDataSource, UITableViewDelegate {
    weak var editor: ComposerEditor?
    var suggestions: [ComposerMentionSuggestion] = []
    var selectedIndex = 0
    func numberOfSections(in tableView: UITableView) -> Int { suggestions.isEmpty ? 0 : 1 }
    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
      suggestions.count
    }
    func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? {
      "Chats"
    }
    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
      let cell = tableView.dequeueReusableCell(withIdentifier: "mention", for: indexPath)
      guard let cell = cell as? MentionCell else {
        preconditionFailure("Mention cells must use the registered MentionCell class")
      }
      let value = suggestions[indexPath.row]
      cell.configure(value) { [weak self] in self?.editor?.insertMention(value) }
      return cell
    }
    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
      editor?.insertMention(suggestions[indexPath.row])
    }
  }

  private final class MentionCell: UITableViewCell {
    private var activate: () -> Void = {}
    func configure(_ value: ComposerMentionSuggestion, activate: @escaping () -> Void) {
      self.activate = activate
      contentConfiguration = UIHostingConfiguration {
        HStack(spacing: OkouSpace.md) {
          OkouAgentAvatar(
            avatarURL: value.avatarURL, name: value.title, size: OkouAvatarSize.message)
          Text(value.title).font(.okou(.body)).foregroundStyle(OkouColor.foreground)
            .lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
        }.frame(minHeight: OkouControl.minimumTarget)
      }.margins(.all, OkouSpace.sm)
      backgroundColor = .clear
      isAccessibilityElement = true
      accessibilityLabel = "Chat: " + value.title
      accessibilityTraits = .button
      accessibilityIdentifier = "mention-" + value.id
    }
    override func prepareForReuse() {
      super.prepareForReuse()
      contentConfiguration = nil
      activate = {}
    }
    override func accessibilityActivate() -> Bool {
      activate()
      return true
    }
  }
}
