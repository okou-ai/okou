import CCState
import CCStateSwiftUI
import ChatData
import SwiftUI

struct ComposerConnectorDirectory: View {
  let store: ComposerConnectorStore
  let resources: ComposerConnectorDirectoryResources
  var showsCustom = true

  var body: some View {
    StoreProvider(resources.store) {
      ComposerConnectorDirectoryContent(
        store: store, resources: resources, showsCustom: showsCustom)
    }
  }
}

private struct ComposerConnectorDirectoryContent: View {
  let store: ComposerConnectorStore
  let resources: ComposerConnectorDirectoryResources
  let showsCustom: Bool
  @LoadableValue private var selection: Loadable<ComposerConnectorDirectoryResources.Selection>
  /// The composer's confirmed connectors and remote access, kept in the session Store.
  @ResolvedValue private var resolvedSnapshot: ComposerConnectorStore.Snapshot?

  init(
    store: ComposerConnectorStore, resources: ComposerConnectorDirectoryResources, showsCustom: Bool
  ) {
    self.store = store
    self.resources = resources
    self.showsCustom = showsCustom
    _selection = LoadableValue(resources.selection)
    _resolvedSnapshot = ResolvedValue(store.snapshotValue)
  }

  private var snapshot: ComposerConnectorStore.Snapshot { resolvedSnapshot ?? store.snapshot }

  var body: some View {
    switch selection {
    case .hasData(let value): content(value)
    case .loading:
      ScrollView {
        ComposerConnectorDirectorySkeleton()
      }
      .okouGroupedBackground(OkouColor.background)
    case .hasError(let error):
      ConnectorLoadError(error: ChatRequestFailure.message(for: error)) {
        await resources.refresh()
      }
    }
  }

  private func content(_ selection: ComposerConnectorDirectoryResources.Selection) -> some View {
    ScrollView {
      VStack(alignment: .leading, spacing: OkouSpace.lg) {
        if showsCustom {
          OkouSegmentControl(
            selection: Binding(
              get: { selection.tab },
              set: { tab in
                resources.update(tab: tab)
              }),
            options: [(.discover, "Discover"), (.custom, "Custom")]
          )
          .padding(.horizontal, OkouSpace.lg)
        }
        if selection.tab == .discover {
          ConnectorDirectoryRead(signal: resources.catalog) { value, isLoading in
            discover(value, selection: selection, isLoading: isLoading)
          }
        } else {
          ConnectorDirectoryRead(signal: resources.customMatches) { value, isLoading in
            custom(value, selection: selection, isLoading: isLoading)
          }
          remoteAccess
        }
      }
      .padding(.bottom, OkouSpace.xxl)
    }
    .okouGroupedBackground(OkouColor.background)
    .navigationTitle(showsCustom ? "Add connectors" : "Connectors")
    .navigationBarTitleDisplayMode(.inline)
    .searchable(
      text: Binding(
        get: { selection.search },
        set: { search in
          resources.update(search: search)
        }),
      prompt: "Find connectors"
    )
    .refreshable { await resources.refresh() }
    .onChange(of: store.webDestination?.id) { _, destinationID in
      if destinationID == nil { Task { await resources.refresh() } }
    }
  }

  @ViewBuilder private func discover(
    _ value: Loadable<ChatConnectorDiscovery>,
    selection: ComposerConnectorDirectoryResources.Selection, isLoading: Bool
  ) -> some View {
    switch value {
    case .loading:
      ComposerConnectorDirectorySkeleton()
    case .hasError(let error):
      ConnectorLoadError(error: ChatRequestFailure.message(for: error), isLoading: isLoading) {
        await resources.refresh()
      }
      .padding(.horizontal, OkouSpace.lg)
    case .hasData(let result):
      if let counts = result.categoryConnectorCounts, !counts.isEmpty {
        OkouChipRail {
          OkouChip(title: Text("All"), isSelected: selection.category.isEmpty) {
            resources.update(category: "")
          }
          ForEach(counts.keys.sorted(), id: \.self) { name in
            OkouChip(
              title: Text(ConnectorCategoryName.short(name)), isSelected: selection.category == name
            ) {
              resources.update(category: name)
            }
          }
        }
      }
      LazyVStack(spacing: OkouSpace.sm) {
        ForEach(result.connectors) { catalogCard($0) }
      }
      .padding(.horizontal, OkouSpace.lg)
      if result.connectors.isEmpty { emptyState(selection) }
    }
  }

  @ViewBuilder private func custom(
    _ value: Loadable<[ChatCustomConnector]>,
    selection: ComposerConnectorDirectoryResources.Selection, isLoading: Bool
  ) -> some View {
    LazyVStack(spacing: OkouSpace.sm) {
      switch value {
      case .loading:
        customCards([])
        ProgressView().frame(maxWidth: .infinity).padding(.top, OkouSpace.xxl)
      case .hasError(let error):
        ConnectorLoadError(error: ChatRequestFailure.message(for: error), isLoading: isLoading) {
          await resources.refresh()
        }
        customCards([])
      case .hasData(let connectors):
        customCards(connectors)
        if connectors.isEmpty { emptyState(selection) }
      }
    }
    .padding(.horizontal, OkouSpace.lg)
  }

  private func catalogCard(_ connector: ChatCatalogConnector) -> some View {
    let added = snapshot.connectors.contains { $0.target.connectorSlug == connector.slug }
    return HStack(spacing: OkouSpace.sm) {
      NavigationLink {
        ComposerConnectorDetail(store: store, connector: connector)
      } label: {
        HStack(spacing: OkouSpace.md) {
          OkouLogoTile(size: OkouControl.logoTile) { ConnectorLogo(icon: connector.icon) }
          VStack(alignment: .leading, spacing: OkouSpace.two) {
            Text(connector.label)
              .font(.okou(.body).weight(.medium))
              .foregroundStyle(OkouColor.foreground)
              .lineLimit(1)
            // As on the web, a connected card trades what the connector does for its status.
            if added {
              Text("Connected")
                .font(.okou(.footnote))
                .foregroundStyle(OkouColor.mutedForeground)
            } else {
              Text(connector.description)
                .font(.okou(.footnote))
                .foregroundStyle(OkouColor.mutedForeground)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
            }
          }
          Spacer(minLength: 0)
          if added {
            OkouAddIndicator(isAdded: true).accessibilityHidden(true)
          }
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      if !added {
        Button {
          store.connect(connector)
        } label: {
          OkouAddIndicator(isAdded: false)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Connect \(connector.label)")
        .accessibilityIdentifier("connect-\(connector.slug)")
      }
    }
    .padding(.leading, OkouSpace.lg)
    .padding(.trailing, OkouSpace.six)
    .padding(.vertical, OkouSpace.md)
    .modifier(OkouSurfaceStyle())
  }

  @ViewBuilder private func customCards(_ connectors: [ChatCustomConnector]) -> some View {
    Button {
      store.openWeb(path: "connectors", query: [URLQueryItem(name: "scope", value: "custom")])
    } label: {
      customCard(title: Text("Create custom connector"), icon: "plus", trailing: "arrow-up-right")
    }
    .buttonStyle(.plain)
    ForEach(connectors, id: \.id) { connector in
      Button {
        if connector.managed || connector.permissionBundleRef != nil {
          openConnector(connector.slug)
        } else {
          store.connect(target: .custom(connector.id))
        }
      } label: {
        customCard(title: Text(connector.displayName), icon: "puzzle", trailing: nil)
      }
      .buttonStyle(.plain)
    }
  }

  private var remoteAccess: some View {
    VStack(alignment: .leading, spacing: OkouSpace.sm) {
      Text("Remote access").okouSectionHeader()
        .padding(.top, OkouSpace.sm)
      Button {
        store.setupRemote(.ssh)
      } label: {
        customCard(title: Text("Set up SSH"), icon: "terminal", trailing: "chevron-right")
      }
      .buttonStyle(.plain)
      Button {
        store.setupRemote(.vnc)
      } label: {
        customCard(title: Text("Set up VNC"), icon: "monitor", trailing: "chevron-right")
      }
      .buttonStyle(.plain)
    }
    .padding(.horizontal, OkouSpace.lg)
  }

  private func customCard(title: Text, icon: String, trailing: String?) -> some View {
    HStack(spacing: OkouSpace.md) {
      OkouLogoTile(size: OkouControl.logoTile) {
        OkouIcon(icon, size: OkouIconSize.standard).foregroundStyle(OkouColor.mutedForeground)
      }
      title
        .font(.okou(.body).weight(.medium))
        .foregroundStyle(OkouColor.foreground)
        .lineLimit(1)
      Spacer(minLength: 0)
      if let trailing {
        OkouIcon(trailing, size: OkouIconSize.inline)
          .foregroundStyle(OkouColor.mutedForeground)
          .accessibilityHidden(true)
      }
    }
    .padding(.horizontal, OkouSpace.lg)
    .padding(.vertical, OkouSpace.md)
    .modifier(OkouSurfaceStyle())
    .contentShape(Rectangle())
  }

  @ViewBuilder private func emptyState(_ selection: ComposerConnectorDirectoryResources.Selection)
    -> some View
  {
    if !selection.search.isEmpty {
      OkouEmptyState(
        "No results", icon: "search", description: Text("Try another search."))
    } else if selection.tab == .custom {
      OkouEmptyState(
        "No custom connectors yet", icon: "puzzle",
        description: Text("Add your own MCP server or API on the web, then use it here."))
    }
  }

  private func openConnector(_ slug: String) {
    store.openWeb(
      path: "connectors/\(slug)/connect")
  }

}

/// Both native phase projections observe the same cached request Task.
private struct ConnectorDirectoryRead<Value: Sendable, Content: View>: View {
  @LoadableValue private var value: Loadable<Value>
  @LoadableStatus<Value> private var status: LoadableState
  let content: (Loadable<Value>, Bool) -> Content

  init(
    signal: Computed<Task<Value, Error>>,
    @ViewBuilder content: @escaping (Loadable<Value>, Bool) -> Content
  ) {
    _value = LoadableValue(task: signal, keepLast: true)
    _status = LoadableStatus(task: signal)
    self.content = content
  }

  var body: some View { content(value, status == .loading) }
}

/// A connector's page in the manner of Manus: the mark, name and what it does on one card,
/// the actions under them, then the facts (status, category, how it signs in).
/// The web's category names (`connector-category-labels.ts`): short ones for chips, the full
/// ones on a connector's page. The catalog sends stable English ids; an id the app does not
/// know yet falls back to a readable title.
enum ConnectorCategoryName {
  static func short(_ id: String) -> String {
    switch id {
    case "ai": String(localized: "AI")
    case "ai-agent-apps": String(localized: "Agent platforms")
    case "ai-general-models": String(localized: "General models")
    case "ai-image-video": String(localized: "Image / video")
    case "ai-memory-tracing-eval": String(localized: "Memory / tracing")
    case "ai-voice-audio": String(localized: "Voice / audio")
    case "communication-collaboration": String(localized: "Communication")
    case "data-automation-infrastructure": String(localized: "Data and automation")
    case "docs-files-knowledge": String(localized: "Documents")
    case "engineering-team-execution": String(localized: "Engineering")
    case "marketing-content-growth": String(localized: "Marketing")
    case "meetings-scheduling": String(localized: "Meetings")
    case "sales-crm-business-operations": String(localized: "Sales and business")
    default: id.replacingOccurrences(of: "-", with: " ").capitalized
    }
  }
  static func full(_ id: String) -> String {
    switch id {
    case "ai": String(localized: "AI")
    case "ai-agent-apps": String(localized: "Agent platforms and AI apps")
    case "ai-general-models": String(localized: "General models and reasoning")
    case "ai-image-video": String(localized: "Image / video generation")
    case "ai-memory-tracing-eval": String(localized: "Memory / tracing / evaluation")
    case "ai-voice-audio": String(localized: "Voice / audio")
    case "communication-collaboration": String(localized: "Communication and collaboration")
    case "data-automation-infrastructure": String(localized: "Data, automation, and infrastructure")
    case "docs-files-knowledge": String(localized: "Docs, files, and knowledge")
    case "engineering-team-execution": String(localized: "Engineering and team execution")
    case "marketing-content-growth": String(localized: "Marketing, content, and growth")
    case "meetings-scheduling": String(localized: "Meetings and scheduling")
    case "sales-crm-business-operations": String(localized: "Sales, CRM, and business operations")
    default: id.replacingOccurrences(of: "-", with: " ").capitalized
    }
  }
}
