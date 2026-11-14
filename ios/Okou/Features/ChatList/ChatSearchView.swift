import CCStateSwiftUI
import ChatData
import ChatDomain
import SwiftUI

/// Workspace search in the app's native sheet, with the field focused on opening. Under the
/// field the web's filter row (`ThreeColumnSearchDialog`): All, Chats, Messages,
/// Workflows and Artifacts. A chat or message opens its chat; a workflow starts a default
/// Agent chat with `/name` in the draft; an artifact opens in the app's preview.
struct ChatSearchView: View {
  let workspace: WorkspaceStore
  var showsArchived = false
  let didOpen: () -> Void
  let openWorkflow: (ChatSearchWorkflow) -> Void

  var body: some View {
    StoreProvider(workspace.search.stateStore) {
      ChatSearchContent(
        workspace: workspace, showsArchived: showsArchived, didOpen: didOpen,
        openWorkflow: openWorkflow
      )
      .id(ObjectIdentifier(workspace.search))
    }
  }
}

/// Search has its own Store; list status must observe the workspace's original read.
private struct ChatSearchListReadStatus: View {
  let list: ThreadListStore

  var body: some View {
    StoreProvider(list.stateStore) {
      ChatSearchListReadStatusContent(list: list)
        .id(ObjectIdentifier(list))
    }
  }
}

private struct ChatSearchListReadStatusContent: View {
  let list: ThreadListStore
  @LoadableValue private var read: Loadable<Void>

  init(list: ThreadListStore) {
    self.list = list
    _read = LoadableValue(task: list.listValue)
  }

  var body: some View {
    if read.state == .loading && list.threads.isEmpty {
      OkouLoadingRow("Loading chats…")
    } else if let error = read.error?.localizedDescription ?? list.error {
      OkouLoadErrorRow(message: error, actionTitle: "Reload chats") {
        await list.refresh()
      }
    }
  }
}

private struct ChatSearchContent: View {
  enum Scope: CaseIterable, Hashable {
    case all, chats, messages, workflows, artifacts

    var title: LocalizedStringKey {
      switch self {
      case .all: "All"
      case .chats: "Chats"
      case .messages: "Messages"
      case .workflows: "Workflows"
      case .artifacts: "Artifacts"
      }
    }
  }

  @Bindable var workspace: WorkspaceStore
  var showsArchived = false
  let didOpen: () -> Void
  let openWorkflow: (ChatSearchWorkflow) -> Void
  @LoadableValue private var messageResults: Loadable<[ChatSearchResult]>
  @LoadableValue private var workflowResults: Loadable<[ChatSearchWorkflow]>
  @LoadableValue private var artifactResults: Loadable<[ChatSearchArtifact]>

  init(
    workspace: WorkspaceStore, showsArchived: Bool, didOpen: @escaping () -> Void,
    openWorkflow: @escaping (ChatSearchWorkflow) -> Void
  ) {
    self.workspace = workspace
    self.showsArchived = showsArchived
    self.didOpen = didOpen
    self.openWorkflow = openWorkflow
    _messageResults = LoadableValue(task: workspace.search.messagesValue)
    _workflowResults = LoadableValue(task: workspace.search.workflowsValue)
    _artifactResults = LoadableValue(task: workspace.search.artifactsValue)
  }

  @Environment(\.openURL) private var openURL
  @State private var openingID: String?
  @State private var scope = Scope.all
  private var search: ChatSearchStore { workspace.search }

  private var messages: [ChatSearchResult] { messageResults.data ?? [] }
  private var workflows: [ChatSearchWorkflow] { workflowResults.data ?? [] }
  private var artifacts: [ChatSearchArtifact] { artifactResults.data ?? [] }
  private var isLoadingMessages: Bool { messageResults.state == .loading }
  private var isLoadingWorkflows: Bool { workflowResults.state == .loading }
  private var isLoadingArtifacts: Bool { artifactResults.state == .loading }
  private var messageError: String? { messageResults.error?.localizedDescription }
  private var workflowsError: String? { workflowResults.error?.localizedDescription }
  private var artifactsError: String? { artifactResults.error?.localizedDescription }

  private var titleThreads: [ChatThread] {
    search.keyword.isEmpty
      ? workspace.list.threads(
        agentID: workspace.selectedAgentID, archived: showsArchived,
        onlyUnread: workspace.sidebar.filter == .unread)
      : workspace.list.threads
  }

  private func shows(_ section: Scope) -> Bool { scope == .all || scope == section }

  var body: some View {
    let titles = search.titleResults(in: titleThreads)
    NavigationStack {
      OkouSearchPage(
        text: Binding(get: { search.query }, set: { search.updateQuery($0) }),
        prompt: "Search", close: { search.dismiss() }
      ) {
        // On the search field's and the rows' leading edge.
        OkouChipRail(inset: OkouSpace.lg) {
          ForEach(Scope.allCases, id: \.self) { item in
            OkouChip(title: Text(item.title), isSelected: scope == item) { scope = item }
          }
        }
      } results: {
        results(titles: titles)
      } empty: {
        emptyState(hasTitles: !titles.isEmpty)
      }
      .sheet(
        isPresented: Binding(
          get: { workspace.searchArtifacts.preview != nil },
          set: { if !$0 { workspace.searchArtifacts.dismiss() } })
      ) {
        MessageArtifactPreview(
          viewer: workspace.searchArtifacts, markdown: workspace.messageMarkdown)
      }
    }
  }

  @ViewBuilder
  private func results(titles: [ChatThread]) -> some View {
    ChatSearchListReadStatus(list: workspace.list)
    if let error = search.openingError {
      Text(error).foregroundStyle(OkouColor.mutedForeground)
    }
    if shows(.chats), !titles.isEmpty {
      Section {
        sectionTitle {
          Text(search.keyword.isEmpty ? LocalizedStringKey("Recent chats") : "Chats")
            .okouSectionHeader()
        }
        ForEach(titles) { thread in
          resultButton(threadID: thread.id) {
            Text(thread.displayTitle).lineLimit(1)
          }
        }
      }
    }
    if shows(.messages), !search.keyword.isEmpty { messagesSection }
    if shows(.workflows) { workflowsSection }
    if shows(.artifacts) { artifactsSection }
  }

  /// Only when there is something to show: a match, the search running, or its error. No
  /// matches anywhere is one empty state for the page (`emptyState`), not an empty section.
  @ViewBuilder
  private var messagesSection: some View {
    if !messages.isEmpty || isLoadingMessages || messageError != nil {
      Section {
        sectionTitle { Text("Messages").okouSectionHeader() }
        // One row per chat: several matches in the same chat are counted, not repeated.
        ForEach(messageGroups, id: \.result.chatThreadId) { group in
          resultButton(threadID: group.result.chatThreadId) {
            VStack(alignment: .leading, spacing: OkouSpace.xs) {
              Text(
                workspace.list.threads.first { $0.id == group.result.chatThreadId }?
                  .displayTitle ?? group.result.agentName
              )
              .lineLimit(1)
              Text(group.result.snippet).font(.okou(.subheadline)).foregroundStyle(
                OkouColor.mutedForeground
              ).lineLimit(2)
              HStack(spacing: OkouSpace.xs) {
                Text(group.result.matchedMessage.createdAt, style: .date)
                if group.count > 1 {
                  Text(verbatim: "·")
                  Text("\(group.count) matches")
                }
              }
              .font(.okou(.caption)).foregroundStyle(OkouColor.mutedForeground)
            }
          }
          .accessibilityIdentifier("search-message-\(group.result.id)")
        }
        if isLoadingMessages {
          OkouLoadingRow("Searching messages…")
        } else if let error = messageError {
          OkouLoadErrorRow(message: error) { search.retry() }
        }
      }
    }
  }

  /// Every workflow without a query when Workflows is chosen; under All only the matches.
  @ViewBuilder
  private var workflowsSection: some View {
    let workflows = self.workflows
    let showsAll = scope == .workflows
    if (showsAll || !search.keyword.isEmpty) && !workflows.isEmpty {
      Section {
        sectionTitle { Text("Workflows").okouSectionHeader() }
        ForEach(workflows) { workflow in
          Button {
            openWorkflow(workflow)
          } label: {
            HStack(alignment: .firstTextBaseline, spacing: OkouSpace.md) {
              OkouLineIcon("workflow", font: .okou(.body))
                .foregroundStyle(OkouColor.mutedForeground)
              VStack(alignment: .leading, spacing: OkouSpace.xs) {
                Text(workflow.title).lineLimit(1)
                Text(workflow.description ?? agentName(workflow.agentId))
                  .font(.okou(.caption)).foregroundStyle(OkouColor.mutedForeground)
                  .lineLimit(1)
              }
              .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
              Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityIdentifier("search-workflow-\(workflow.id)")
        }
      }
    } else if showsAll, isLoadingWorkflows {
      OkouLoadingRow("Loading workflows…")
    } else if showsAll, let error = workflowsError {
      OkouLoadErrorRow(message: error) { search.retryWorkflows() }
    }
  }

  /// Artifacts are searched on the server, so they appear only for a query.
  @ViewBuilder
  private var artifactsSection: some View {
    if !search.keyword.isEmpty {
      if !artifacts.isEmpty {
        Section {
          sectionTitle { Text("Artifacts").okouSectionHeader() }
          ForEach(artifacts) { item in
            Button {
              open(item)
            } label: {
              HStack(alignment: .firstTextBaseline, spacing: OkouSpace.md) {
                OkouLineIcon(Self.symbol(for: item), font: .okou(.body))
                  .foregroundStyle(OkouColor.mutedForeground)
                Text(item.title).lineLimit(1)
                  .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
                Spacer(minLength: 0)
              }
              .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("search-artifact-\(item.id)")
          }
        }
      } else if scope == .artifacts {
        if isLoadingArtifacts {
          OkouLoadingRow("Searching artifacts…")
        } else if let error = artifactsError {
          OkouLoadErrorRow(message: error) { search.retry() }
        }
      }
    }
  }

  /// The kind's glyph, and for a file the glyph of its format, as its result card shows it.
  private static func symbol(for item: ChatSearchArtifact) -> String {
    switch item.kind {
    case "hosted-site": "globe"
    case "presentation": "presentation"
    case "image", "avatar": "image"
    case "video": "video"
    default: ChatArtifact(source: .file(item.id), filename: item.title).symbol
    }
  }

  /// The result in the app's own preview, named as the catalog names it. A site opens at its
  /// public alias: its `sourceUrl` is the internal deployment host (`dpl-….sites.vm0.io`),
  /// which does not resolve outside. An address the app cannot read opens the web's Artifacts
  /// page instead.
  private func open(_ item: ChatSearchArtifact) {
    let viewer = workspace.searchArtifacts
    guard let address = item.aliasUrl ?? item.sourceUrl, let parsed = viewer.resource(address)
    else {
      var page = URLComponents(
        url: workspace.webURL.appending(path: "artifacts"), resolvingAgainstBaseURL: false)
      page?.queryItems = [URLQueryItem(name: "artifact", value: item.id)]
      if let url = page?.url { openURL(url) }
      return
    }
    // A file keeps its format in its name, so the preview knows what it is; a site's name
    // comes from its host and has none.
    var name = item.title
    let format = (parsed.filename as NSString).pathExtension
    if item.kind != "hosted-site", !format.isEmpty, (name as NSString).pathExtension.isEmpty {
      name += "." + format
    }
    viewer.open(
      ChatArtifact(
        source: parsed.source, filename: name, contentType: parsed.contentType,
        artifactKind: item.kind == "presentation" ? "presentation-html" : nil))
  }

  /// The page's empty state where a scope has nothing to show yet.
  @ViewBuilder
  private func emptyState(hasTitles: Bool) -> some View {
    let keyword = search.keyword
    if keyword.isEmpty && scope == .messages {
      pageState(
        "Search messages", icon: "messages-square",
        description: "Find a message by any word in it.")
    } else if keyword.isEmpty && scope == .artifacts {
      pageState(
        "Search artifacts", icon: "layers",
        description: "Find a file, site or deck by its name.")
    } else if !keyword.isEmpty && !isLoadingMessages && messageError == nil {
      switch scope {
      case .all
      where !hasTitles && messages.isEmpty && workflows.isEmpty
        && artifacts.isEmpty && !isLoadingArtifacts:
        noResults(messages: true)
      case .messages where messages.isEmpty:
        noResults(messages: true)
      case .chats where !hasTitles:
        noResults(messages: false)
      case .workflows where workflows.isEmpty && !isLoadingWorkflows:
        noResults(messages: false)
      case .artifacts
      where artifacts.isEmpty && !isLoadingArtifacts && artifactsError == nil:
        noResults(messages: false)
      default:
        EmptyView()
      }
    }
  }

  /// A section's title as its first row, so it scrolls away with the section: a plain list's
  /// `header:` stays pinned over the rows scrolling beneath it.
  private func sectionTitle<Title: View>(@ViewBuilder _ title: () -> Title) -> some View {
    title()
      .padding(.top, OkouSpace.sm)
      .listRowSeparator(.hidden)
      .accessibilityAddTraits(.isHeader)
  }

  /// Nothing matched. Where messages are searched it says why a recent one may be missing;
  /// elsewhere it suggests another search.
  private func noResults(messages: Bool) -> some View {
    pageState(
      "No results", icon: "search",
      description: messages
        ? "Recent messages may take time to appear in search." : "Try another search.")
  }

  /// The page's one empty state, from the design system: a scope that only searches before
  /// anything is typed, or nothing matched.
  private func pageState(
    _ title: LocalizedStringKey, icon: String, description: LocalizedStringKey
  ) -> some View {
    OkouEmptyState(title, icon: icon, description: Text(description))
  }

  private var messageGroups: [(result: ChatSearchResult, count: Int)] {
    var order: [String] = []
    var groups: [String: (result: ChatSearchResult, count: Int)] = [:]
    for result in messages {
      if let existing = groups[result.chatThreadId] {
        groups[result.chatThreadId] = (existing.result, existing.count + 1)
      } else {
        order.append(result.chatThreadId)
        groups[result.chatThreadId] = (result, 1)
      }
    }
    return order.compactMap { groups[$0] }
  }

  private func agentName(_ id: String) -> String {
    workspace.list.agents.first { $0.agentId == id }?.displayName ?? id
  }

  private func resultButton<Content: View>(threadID: String, @ViewBuilder label: () -> Content)
    -> some View
  {
    Button {
      openingID = threadID
      Task {
        defer { openingID = nil }
        if await workspace.openSearchResult(threadID) { didOpen() }
      }
    } label: {
      HStack {
        label().frame(maxWidth: .infinity, alignment: .leading)
        if openingID == threadID { ProgressView().controlSize(.small) }
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(openingID != nil)
  }
}
