import ChatData
import ChatDomain
import SwiftUI

/// Workspace search as a full page, as ChatGPT, Claude and Perplexity open theirs: it grows
/// out of the sidebar's search capsule and fills the screen, the field at the top. Under the
/// field the web's filter row (`ThreeColumnSearchDialog`): All, Chats, Messages, Agents,
/// Workflows and Artifacts. A chat or message opens its chat; an agent starts its new chat; a
/// workflow starts its agent's new chat with `/name` in the draft, as the composer's `/` menu
/// does; an artifact opens in the app's preview.
struct ChatSearchView: View {
  enum Scope: CaseIterable, Hashable {
    case all, chats, messages, agents, workflows, artifacts

    var title: LocalizedStringKey {
      switch self {
      case .all: "All"
      case .chats: "Chats"
      case .messages: "Messages"
      case .agents: "Agents"
      case .workflows: "Workflows"
      case .artifacts: "Artifacts"
      }
    }
  }

  @Bindable var workspace: WorkspaceStore
  var showsArchived = false
  let didOpen: () -> Void
  let openAgent: (String) -> Void
  let openWorkflow: (ChatSearchWorkflow) -> Void
  @Environment(\.openURL) private var openURL
  @State private var openingID: String?
  @State private var scope = Scope.all
  private var search: ChatSearchStore { workspace.search }

  private var titleThreads: [ChatThread] {
    search.keyword.isEmpty
      ? workspace.list.threads(agentID: workspace.selectedAgentID, archived: showsArchived)
      : workspace.list.threads
  }

  private var agents: [AgentRecord] {
    let keyword = search.keyword
    return workspace.list.agents.filter { agent in
      keyword.isEmpty || (agent.displayName ?? "Okou").lowercased().contains(keyword)
    }
  }

  private func shows(_ section: Scope) -> Bool { scope == .all || scope == section }

  var body: some View {
    NavigationStack {
      List {
        if workspace.list.isLoading && workspace.list.threads.isEmpty {
          OkouLoadingRow("Loading chats…")
        } else if let error = workspace.list.error {
          OkouLoadErrorRow(message: error, actionTitle: "Reload chats") {
            await workspace.list.refresh()
          }
        }
        if let error = search.openingError {
          Text(error).foregroundStyle(OkouColor.mutedForeground)
        }
        let titles = search.titleResults(in: titleThreads)
        if shows(.chats), !titles.isEmpty {
          Section {
            sectionTitle {
              Text(search.keyword.isEmpty ? LocalizedStringKey("Recent chats") : "Chats")
                .okouSectionHeader()
            }
            ForEach(titles) { thread in
              resultButton(threadID: thread.id) {
                VStack(alignment: .leading, spacing: OkouSpace.xs) {
                  Text(thread.displayTitle).lineLimit(1)
                  Text(agentName(thread.agentID)).font(.okou(.caption)).foregroundStyle(
                    OkouColor.mutedForeground)
                }
              }
            }
          }
        }
        if shows(.messages), !search.keyword.isEmpty { messagesSection }
        if shows(.agents), !agents.isEmpty, scope == .agents || !search.keyword.isEmpty {
          agentsSection
        }
        if shows(.workflows) { workflowsSection }
        if shows(.artifacts) { artifactsSection }
        emptyState(hasTitles: !titles.isEmpty)
      }
      .listStyle(.plain)
      .scrollContentBackground(.hidden)
      .background(OkouColor.background)
      // The field and the filters sit on a solid page-coloured header, as ChatGPT, Claude and
      // Perplexity draw search: results end cleanly under it instead of blurring through.
      .scrollEdgeEffectStyle(.hard, for: .top)
      .scrollDismissesKeyboard(.immediately)
      .safeAreaBar(edge: .top, spacing: 0) {
        // On the search field's and the rows' leading edge.
        OkouChipRail(inset: OkouSpace.lg) {
          ForEach(Scope.allCases, id: \.self) { item in
            OkouChip(title: Text(item.title), isSelected: scope == item) { scope = item }
          }
        }
        .padding(.vertical, OkouSpace.sm)
        .background(OkouColor.background)
      }
      .navigationTitle("Search")
      .navigationBarTitleDisplayMode(.inline)
      // The system search interaction (the field rises into the bar while typing) in the app's
      // style: Lucide glyphs and placeholder grey (`OkouNavigationBar.applySearchField()`).
      .searchable(
        text: Binding(get: { search.query }, set: { search.updateQuery($0) }),
        placement: .navigationBarDrawer(displayMode: .always),
        prompt: "Search"
      )
      .toolbar {
        OkouCloseToolbarItem { search.dismiss() }
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

  private var messagesSection: some View {
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
      if search.isLoading {
        OkouLoadingRow("Searching messages…")
      } else if let error = search.error {
        OkouLoadErrorRow(message: error) { search.retry() }
      } else if search.messages.isEmpty, scope == .messages {
        Text("No matching messages.").foregroundStyle(OkouColor.mutedForeground)
      }
      sectionNote { Text("Recent messages may take time to appear in search.").okouSectionNote() }
    }
  }

  private var agentsSection: some View {
    Section {
      sectionTitle { Text("Agents").okouSectionHeader() }
      ForEach(agents, id: \.agentId) { agent in
        Button {
          openAgent(agent.agentId)
        } label: {
          HStack(spacing: OkouSpace.md) {
            OkouAgentAvatar(
              avatarURL: agent.avatarUrl, name: agent.displayName ?? "Okou",
              isDefault: agent.isDefaultAgent, size: OkouAvatarSize.row)
            Text(agent.displayName ?? "Okou").lineLimit(1)
              .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
            Spacer(minLength: 0)
          }
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("search-agent-\(agent.agentId)")
      }
    }
  }

  /// Every workflow without a query when Workflows is chosen; under All only the matches.
  @ViewBuilder
  private var workflowsSection: some View {
    let workflows = search.workflows
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
    } else if showsAll, search.isLoadingWorkflows {
      OkouLoadingRow("Loading workflows…")
    } else if showsAll, let error = search.workflowsError {
      OkouLoadErrorRow(message: error) { search.retryWorkflows() }
    }
  }

  /// Artifacts are searched on the server, so they appear only for a query.
  @ViewBuilder
  private var artifactsSection: some View {
    if !search.keyword.isEmpty {
      if !search.artifacts.isEmpty {
        Section {
          sectionTitle { Text("Artifacts").okouSectionHeader() }
          ForEach(search.artifacts) { item in
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
        if search.isLoadingArtifacts {
          OkouLoadingRow("Searching artifacts…")
        } else if let error = search.artifactsError {
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

  /// One quiet line where a scope has nothing to show yet.
  @ViewBuilder
  private func emptyState(hasTitles: Bool) -> some View {
    let keyword = search.keyword
    if keyword.isEmpty && scope == .messages {
      note("Type to search messages across this workspace.")
    } else if keyword.isEmpty && scope == .artifacts {
      note("Type to search artifacts across this workspace.")
    } else if !keyword.isEmpty && !search.isLoading && search.error == nil {
      switch scope {
      case .all
      where !hasTitles && search.messages.isEmpty && agents.isEmpty && search.workflows.isEmpty
        && search.artifacts.isEmpty && !search.isLoadingArtifacts:
        note("No matching results.")
      case .chats where !hasTitles:
        note("No matching chats.")
      case .agents where agents.isEmpty:
        note("No matching agents.")
      case .workflows where search.workflows.isEmpty && !search.isLoadingWorkflows:
        note("No matching workflows.")
      case .artifacts
      where search.artifacts.isEmpty && !search.isLoadingArtifacts && search.artifactsError == nil:
        note("No matching artifacts.")
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

  /// A section's note as its last row, for the same reason.
  private func sectionNote<Note: View>(@ViewBuilder _ note: () -> Note) -> some View {
    note().listRowSeparator(.hidden)
  }

  private func note(_ text: LocalizedStringKey) -> some View {
    Text(text)
      .font(.okou(.subheadline))
      .foregroundStyle(OkouColor.mutedForeground)
      .listRowSeparator(.hidden)
  }

  private var messageGroups: [(result: ChatSearchResult, count: Int)] {
    var order: [String] = []
    var groups: [String: (result: ChatSearchResult, count: Int)] = [:]
    for result in search.messages {
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
