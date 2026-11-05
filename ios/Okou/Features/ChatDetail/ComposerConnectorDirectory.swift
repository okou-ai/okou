import ChatData
import SwiftUI

/// The connector catalog in the web directory's colours, on the same white page: a segment
/// control switches between the catalog and the connections the workspace set up itself,
/// categories are chips that scroll sideways, and every connector is a card. "+" on a card adds it straight away and the rest opens its detail; a connected card
/// says "Connected" under its name and opens its detail from anywhere.
struct ComposerConnectorDirectory: View {
  let store: ComposerConnectorStore
  @State private var tab = Tab.discover
  @State private var search = ""
  @State private var category = ""
  @State private var catalog: [ChatCatalogConnector] = []
  @State private var custom: [ChatCustomConnector] = []
  @State private var categories: [String] = []
  @State private var error: String?
  @State private var loading = false
  @State private var requestID = UUID()

  private enum Tab { case discover, custom }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: OkouSpace.lg) {
        OkouSegmentControl(
          selection: $tab, options: [(Tab.discover, "Discover"), (Tab.custom, "Custom")]
        )
        .padding(.horizontal, OkouSpace.lg)
        if tab == .discover && !categories.isEmpty {
          OkouChipRail {
            OkouChip(title: Text("All"), isSelected: category.isEmpty) { category = "" }
            ForEach(categories, id: \.self) { name in
              OkouChip(
                title: Text(ConnectorCategoryName.short(name)), isSelected: category == name
              ) {
                category = name
              }
            }
          }
        }
        if let error {
          ConnectorLoadError(error: error) { await load() }
            .padding(.horizontal, OkouSpace.lg)
        }
        LazyVStack(spacing: OkouSpace.sm) {
          if tab == .discover {
            ForEach(catalog) { catalogCard($0) }
          } else {
            customCards
          }
        }
        .padding(.horizontal, OkouSpace.lg)
        if loading && isEmpty {
          ProgressView().frame(maxWidth: .infinity).padding(.top, OkouSpace.xxl)
        } else if !loading && error == nil && isEmpty {
          emptyState
        }
        if tab == .custom {
          remoteAccess
        }
      }
      .padding(.bottom, OkouSpace.xxl)
    }
    .okouGroupedBackground(OkouColor.background)
    .navigationTitle("Add connectors")
    .navigationBarTitleDisplayMode(.inline)
    .searchable(text: $search, prompt: "Find connectors")
    .task(id: "\(tab)/\(search)/\(category)") { await load() }
    .refreshable { await load() }
    .onChange(of: store.webDestination?.id) { _, destinationID in
      if destinationID == nil { Task { await load() } }
    }
  }

  private var visibleCustom: [ChatCustomConnector] {
    custom.filter { search.isEmpty || $0.displayName.localizedCaseInsensitiveContains(search) }
  }

  private var isEmpty: Bool {
    if tab == .discover { return catalog.isEmpty }
    return visibleCustom.isEmpty
  }

  private func catalogCard(_ connector: ChatCatalogConnector) -> some View {
    let added = store.connectors.contains { $0.target.connectorSlug == connector.slug }
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
          Self.connect(connector, store: store)
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

  @ViewBuilder private var customCards: some View {
    Button {
      store.openWeb(path: "connectors", query: [URLQueryItem(name: "scope", value: "custom")])
    } label: {
      customCard(title: Text("Create custom connector"), icon: "plus", trailing: "arrow-up-right")
    }
    .buttonStyle(.plain)
    ForEach(visibleCustom, id: \.id) { connector in
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

  @ViewBuilder private var emptyState: some View {
    if !search.isEmpty {
      OkouEmptyState(
        "No results", icon: "search", description: Text("Try another search."))
    } else if tab == .custom {
      OkouEmptyState(
        "No custom connectors yet", icon: "puzzle",
        description: Text("Add your own MCP server or API on the web, then use it here."))
    }
  }

  private func openConnector(_ slug: String) {
    guard let agentID = store.agentID else { return }
    store.openWeb(
      path: "connectors/\(slug)/connect", query: [URLQueryItem(name: "agentId", value: agentID)])
  }

  /// Sign-in in the app when the connector has an account method; a connector that Okou
  /// manages for the workspace is set up on the web.
  fileprivate static func connect(_ connector: ChatCatalogConnector, store: ComposerConnectorStore)
  {
    if connector.authMethods.contains(where: { $0.grantKind != "managed" }) {
      store.connect(target: .builtin(connector.slug))
    } else if let agentID = store.agentID {
      store.openWeb(
        path: "connectors/\(connector.slug)/connect",
        query: [URLQueryItem(name: "agentId", value: agentID)])
    }
  }

  private func load() async {
    let request = UUID()
    requestID = request
    loading = true
    defer { if requestID == request { loading = false } }
    do {
      if tab == .discover {
        let result = try await store.service.discover(
          keyword: search, category: category.isEmpty ? nil : category)
        guard !Task.isCancelled, requestID == request else { return }
        catalog = result.connectors
        if let counts = result.categoryConnectorCounts { categories = counts.keys.sorted() }
      } else {
        let result = try await store.service.customConnectors()
        guard !Task.isCancelled, requestID == request else { return }
        custom = result
      }
      error = nil
    } catch is CancellationError {
    } catch {
      guard requestID == request else { return }
      self.error = ChatRequestFailure.message(for: error)
    }
  }
}

/// A connector's page in the manner of Manus: the mark, name and what it does on one card,
/// the actions under them, then the facts (status, category, how it signs in).
private struct ComposerConnectorDetail: View {
  let store: ComposerConnectorStore
  let connector: ChatCatalogConnector

  private var added: Bool {
    store.connectors.contains { $0.target.connectorSlug == connector.slug }
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: OkouSpace.lg) {
        hero
        facts
        // One method is already named under "Sign in with"; several are worth explaining.
        if connector.authMethods.count > 1 {
          methods
        }
      }
      .padding(.horizontal, OkouSpace.lg)
      .padding(.bottom, OkouSpace.xxl)
    }
    .okouGroupedBackground(OkouColor.background)
    .navigationTitle("")
    .navigationBarTitleDisplayMode(.inline)
  }

  private var hero: some View {
    VStack(spacing: OkouSpace.md) {
      OkouLogoTile(size: OkouControl.logoTileLarge) {
        ConnectorLogo(icon: connector.icon, pointSize: OkouIconSize.partnerLogoLarge)
      }
      VStack(spacing: OkouSpace.xs) {
        Text(connector.label)
          .font(.okou(.title3).weight(.semibold))
          .foregroundStyle(OkouColor.foreground)
        Text(connector.description)
          .font(.okou(.subheadline))
          .foregroundStyle(OkouColor.mutedForeground)
          .multilineTextAlignment(.center)
          .textSelection(.enabled)
      }
      HStack(spacing: OkouSpace.sm) {
        Button {
          ComposerConnectorDirectory.connect(connector, store: store)
        } label: {
          if added {
            OkouCompactButtonLabel("Add account", icon: "plus")
          } else {
            OkouCompactButtonLabel("Connect", icon: "plug")
          }
        }
        .buttonStyle(OkouButtonStyle(isPrimary: !added, isCompact: true))
        .accessibilityIdentifier("connector-connect")
        if connector.permissionSummary.hasPermissions {
          NavigationLink {
            ComposerConnectorPermissions(store: store, slug: connector.slug, label: connector.label)
          } label: {
            OkouCompactButtonLabel("Permissions", icon: "shield-check")
          }
          .buttonStyle(OkouButtonStyle(isPrimary: false, isCompact: true))
        }
      }
      .padding(.top, OkouSpace.sm)
    }
    .frame(maxWidth: .infinity)
    .padding(OkouSpace.xl)
    .modifier(OkouSurfaceStyle())
  }

  private var facts: some View {
    VStack(spacing: 0) {
      factRow("Status") {
        HStack(spacing: OkouSpace.xs) {
          if added {
            OkouIcon("check", size: OkouIconSize.inline).foregroundStyle(OkouStatusColor.success)
            Text("Connected")
          } else {
            Text("Not connected")
          }
        }
      }
      Divider()
      factRow("Category") { Text(ConnectorCategoryName.full(connector.category)) }
      if !connector.authMethods.isEmpty {
        Divider()
        factRow("Sign in with") {
          Text(connector.authMethods.map(\.label).joined(separator: ", "))
        }
      }
    }
    .padding(.horizontal, OkouSpace.lg)
    .modifier(OkouSurfaceStyle())
  }

  private func factRow<Value: View>(_ label: LocalizedStringKey, @ViewBuilder value: () -> Value)
    -> some View
  {
    HStack(spacing: OkouSpace.md) {
      Text(label).foregroundStyle(OkouColor.mutedForeground)
      Spacer(minLength: 0)
      value().foregroundStyle(OkouColor.foreground).multilineTextAlignment(.trailing)
    }
    .font(.okou(.subheadline))
    .frame(minHeight: OkouControl.listRow)
  }

  private var methods: some View {
    VStack(alignment: .leading, spacing: OkouSpace.sm) {
      Text("Connection methods").okouSectionHeader()
      VStack(alignment: .leading, spacing: 0) {
        ForEach(Array(connector.authMethods.enumerated()), id: \.offset) { index, method in
          if index > 0 { Divider() }
          VStack(alignment: .leading, spacing: OkouSpace.two) {
            Text(method.label).font(.okou(.subheadline).weight(.medium))
            if let description = method.description, !description.isEmpty {
              Text(description)
                .font(.okou(.footnote))
                .foregroundStyle(OkouColor.mutedForeground)
            }
          }
          .padding(.vertical, OkouSpace.md)
          .frame(maxWidth: .infinity, alignment: .leading)
        }
      }
      .padding(.horizontal, OkouSpace.lg)
      .modifier(OkouSurfaceStyle())
    }
  }
}

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
