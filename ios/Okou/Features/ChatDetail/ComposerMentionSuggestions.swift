import ChatData
import ChatDomain
import SwiftUI

/// Workspace navigation snapshots, independent of the sidebar's Agent/filter selection.
struct ComposerMentionSource: Equatable {
  let agentID: String?
  let agents: [AgentRecord]
  let threads: [ChatThread]

  func suggestions(for query: String) -> [ComposerMentionSuggestion] {
    guard let agentID else { return [] }
    let query = query.lowercased()
    let matchingAgents = agents.filter {
      $0.agentId != agentID
        && (query.isEmpty || ($0.displayName ?? $0.agentId).lowercased().contains(query))
    }
    let agentSuggestions = (query.isEmpty ? Array(matchingAgents.prefix(3)) : matchingAgents).map {
      ComposerMentionSuggestion(
        kind: .agent, referenceID: $0.agentId, title: $0.displayName ?? $0.agentId,
        avatarURL: $0.avatarUrl)
    }
    // The PWA reducer orders pinned chats first, then activity and ID; it does
    // not apply the sidebar's fractional pin ranking to mention suggestions.
    let chats = ChatThreadReplay.replay(snapshot: threads, events: []).filter {
      !$0.title.isEmpty && (query.isEmpty || $0.title.lowercased().contains(query))
    }.prefix(25).map { thread in
      ComposerMentionSuggestion(
        kind: .chat, referenceID: thread.id, title: thread.title,
        avatarURL: agents.first(where: { $0.agentId == thread.agentID })?.avatarUrl)
    }
    return agentSuggestions + chats
  }
}

struct ComposerMentionSuggestion: Equatable, Identifiable {
  enum Kind { case agent, chat }
  let kind: Kind
  let referenceID: String
  let title: String
  let avatarURL: String?
  var id: String { "\(kind)-\(referenceID)" }
  var part: MessageJSON {
    switch kind {
    case .agent:
      .object([
        "type": .string("agent"), "agentId": .string(referenceID), "nameSnapshot": .string(title),
      ])
    case .chat:
      .object([
        "type": .string("chat_thread"), "threadId": .string(referenceID),
        "titleSnapshot": .string(title),
      ])
    }
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
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
    .clipShape(RoundedRectangle(cornerRadius: 16))
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
    guard suggestions.indices.contains(selectedIndex),
      let path = coordinator.path(for: selectedIndex)
    else { return }
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
    private var sections: [ComposerMentionSuggestion.Kind] {
      [.agent, .chat].filter { kind in suggestions.contains { $0.kind == kind } }
    }
    private func rows(_ section: Int) -> [ComposerMentionSuggestion] {
      suggestions.filter { $0.kind == sections[section] }
    }
    func path(for index: Int) -> IndexPath? {
      let value = suggestions[index]
      guard let section = sections.firstIndex(of: value.kind),
        let row = rows(section).firstIndex(of: value)
      else { return nil }
      return IndexPath(row: row, section: section)
    }
    func numberOfSections(in tableView: UITableView) -> Int { sections.count }
    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
      rows(section).count
    }
    func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? {
      sections[section] == .agent ? "Agents" : "Chats"
    }
    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
      let cell = tableView.dequeueReusableCell(withIdentifier: "mention", for: indexPath)
      guard let cell = cell as? MentionCell else {
        preconditionFailure("Mention cells must use the registered MentionCell class")
      }
      let value = rows(indexPath.section)[indexPath.row]
      cell.configure(value) { [weak self] in self?.editor?.insertMention(value) }
      return cell
    }
    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
      editor?.insertMention(rows(indexPath.section)[indexPath.row])
    }
  }

  private final class MentionCell: UITableViewCell {
    private var activate: () -> Void = {}
    private var avatarTask: Task<Void, Never>?
    func configure(_ value: ComposerMentionSuggestion, activate: @escaping () -> Void) {
      self.activate = activate
      avatarTask?.cancel()
      var content = defaultContentConfiguration()
      content.text = value.title
      content.textProperties.font = .preferredFont(forTextStyle: .body)
      content.textProperties.numberOfLines = 2
      content.image = UIImage(
        systemName: value.kind == .agent ? "person.crop.circle" : "bubble.left")
      content.imageProperties.maximumSize = CGSize(width: 24, height: 24)
      content.imageProperties.cornerRadius = 12
      contentConfiguration = content
      backgroundColor = .clear
      isAccessibilityElement = true
      accessibilityLabel = (value.kind == .agent ? "Agent: " : "Chat: ") + value.title
      accessibilityTraits = .button
      accessibilityIdentifier = "mention-" + value.id
      guard let url = value.avatarURL.flatMap(URL.init(string:)),
        ["https", "http"].contains(url.scheme)
      else { return }
      avatarTask = Task { [weak self] in
        do {
          let (data, _) = try await URLSession.shared.data(from: url)
          try Task.checkCancellation()
          guard let self, let image = UIImage(data: data) else { return }
          var content = self.contentConfiguration as? UIListContentConfiguration
          content?.image = image
          self.contentConfiguration = content
        } catch {
          // Keep the native placeholder for unavailable artwork.
        }
      }
    }
    override func prepareForReuse() {
      super.prepareForReuse()
      avatarTask?.cancel()
      activate = {}
    }
    deinit { avatarTask?.cancel() }
    override func accessibilityActivate() -> Bool {
      activate()
      return true
    }
  }
}
