import CCState
import CCStateSwiftUI
import ChatData
import SwiftUI

struct ComposerConnectorDirectory: View {
  let store: ComposerConnectorStore
  let resources: ComposerConnectorDirectoryResources

  var body: some View {
    StoreProvider(resources.store) {
      ComposerConnectorDirectoryContent(store: store, resources: resources)
    }
  }
}

private struct ComposerConnectorDirectoryContent: View {
  let store: ComposerConnectorStore
  let resources: ComposerConnectorDirectoryResources
  @LoadableValue private var selection: Loadable<ComposerConnectorDirectoryResources.Selection>
  @LoadableValue private var catalog: Loadable<ChatConnectorDiscovery>
  @LoadableStatus<ChatConnectorDiscovery> private var catalogStatus: LoadableState
  /// The composer's confirmed connectors and remote access, kept in the session Store.
  @ResolvedValue private var resolvedSnapshot: ComposerConnectorStore.Snapshot?
  /// The web page a connector action opened, kept in the same Store.
  @ResolvedValue private var connectorStatus: ComposerConnectorStore.Status?

  init(store: ComposerConnectorStore, resources: ComposerConnectorDirectoryResources) {
    self.store = store
    self.resources = resources
    _selection = LoadableValue(resources.selection)
    _catalog = LoadableValue(task: resources.catalog, keepLast: true)
    _catalogStatus = LoadableStatus(task: resources.catalog)
    _resolvedSnapshot = ResolvedValue(store.snapshotValue)
    _connectorStatus = ResolvedValue(store.statusValue)
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
        discover(selection)
      }
      .padding(.bottom, OkouSpace.xxl)
    }
    .okouGroupedBackground(OkouColor.background)
    .searchable(
      text: Binding(
        get: { selection.search },
        set: { search in
          resources.update(search: search)
        }),
      prompt: "Find connectors"
    )
    .refreshable { await resources.refresh() }
    .onChange(of: (connectorStatus ?? store.status).webDestination?.id) { _, destinationID in
      if destinationID == nil { Task { await resources.refresh() } }
    }
  }

  @ViewBuilder private func discover(_ selection: ComposerConnectorDirectoryResources.Selection)
    -> some View
  {
    switch catalog {
    case .loading:
      ComposerConnectorDirectorySkeleton()
    case .hasError(let error):
      ConnectorLoadError(
        error: ChatRequestFailure.message(for: error), isLoading: catalogStatus == .loading
      ) {
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
      if result.connectors.isEmpty && !selection.search.isEmpty {
        OkouEmptyState("No results", icon: "search", description: Text("Try another search."))
      }
    }
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
