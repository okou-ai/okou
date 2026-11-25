import CCStateSwiftUI
import ChatData
import SwiftUI

struct SettingsConnectorsSection: View {
  let open: () -> Void
  @ResolvedValue private var switches: SidebarFeatureSwitches?

  init(workspace: WorkspaceStore, open: @escaping () -> Void) {
    self.open = open
    _switches = ResolvedValue(task: workspace.settingsResources.featureSwitches, keepLast: true)
  }

  var body: some View {
    if switches?.canManageConnectors == true {
      Section {
        Button(action: open) {
          HStack {
            OkouRowLabel("Connectors", okouSymbol: "plug")
            Spacer(minLength: 0)
            OkouIcon("chevron-right", size: OkouIconSize.inline)
              .foregroundStyle(OkouColor.mutedForeground)
          }
        }
      } header: {
        Text("Connections").okouSectionHeader()
      }
    }
  }
}

struct SettingsConnectorsView: View {
  let store: ComposerConnectorStore
  @State private var tab = "connected"
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    Group {
      if tab == "discover", let directory = store.directory {
        ComposerConnectorDirectory(store: store, resources: directory, showsCustom: false)
      } else if let resources = store.resources {
        StoreProvider(resources.store) {
          SettingsConnectedConnectors(store: store, resources: resources)
        }
      }
    }
    .safeAreaInset(edge: .top) {
      OkouSegmentControl(
        selection: $tab, options: [("connected", "Connected"), ("discover", "Discover")]
      )
      .padding(.horizontal, OkouSpace.lg).padding(.vertical, OkouSpace.sm)
      .background(OkouColor.background)
    }
    .navigationTitle("Connectors").navigationBarTitleDisplayMode(.inline)
    .task {
      if store.directory == nil { store.openDirectory() }
      await store.refresh()
    }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active { Task { await store.refresh() } }
    }
  }
}

private struct SettingsConnectedConnectors: View {
  let store: ComposerConnectorStore
  @LoadableValue private var connected: Loadable<[ChatComposerConnector]>
  @State private var search = ""
  @State private var detail: ComposerConnectorAccountResources?

  init(store: ComposerConnectorStore, resources: ComposerConnectorResources) {
    self.store = store
    _connected = LoadableValue(task: resources.connected, keepLast: true)
  }

  var body: some View {
    List {
      ComposerConnectorReadError(store: store) { await store.refresh() }
      switch connected {
      case .loading: OkouLoadingRow("Loading connectors…")
      case .hasError: EmptyView()
      case .hasData(let entries):
        let matches = entries.filter {
          search.isEmpty || $0.label.localizedCaseInsensitiveContains(search)
        }
        let attention = matches.filter(\.needsAttention)
        let ready = matches.filter { !$0.needsAttention }
        if !attention.isEmpty {
          Section {
            ForEach(attention) { row($0) }
          } header: {
            Text("Needs attention").okouSectionHeader()
          }
        }
        if !ready.isEmpty {
          Section {
            ForEach(ready) { row($0) }
          } header: {
            Text("Connected").okouSectionHeader()
          }
        }
        if matches.isEmpty {
          Text(search.isEmpty ? "No connectors yet" : "No connectors found")
            .foregroundStyle(OkouColor.mutedForeground)
        }
      }
    }
    .okouGroupedBackground().listSectionSpacing(OkouSpace.lg)
    .searchable(text: $search, prompt: "Find connectors")
    .refreshable { await store.refresh() }
    .navigationDestination(
      isPresented: Binding(
        get: { detail != nil },
        set: {
          if !$0 {
            detail?.close()
            detail = nil
          }
        })
    ) {
      if let detail {
        StoreProvider(detail.store) {
          SettingsConnectorDetail(store: store, resources: detail)
        }.id(ObjectIdentifier(detail))
      }
    }
  }

  private func row(_ connector: ChatComposerConnector) -> some View {
    Button {
      detail = store.openAccounts(connector, managesDefaults: true)
    } label: {
      HStack(spacing: OkouSpace.md) {
        ConnectorLogo(icon: connector.icon)
          .frame(width: OkouControl.rowLeadingSlot, height: OkouControl.rowLeadingSlot)
        VStack(alignment: .leading, spacing: OkouSpace.xs) {
          Text(connector.label).foregroundStyle(OkouColor.foreground)
          if connector.needsAttention {
            Text("Reconnect required").font(.okou(.footnote))
              .foregroundStyle(OkouStatusColor.warning)
          }
        }
        Spacer(minLength: 0)
        if !connector.needsAttention {
          accountCount(connector.access.accounts.count)
            .font(.okou(.body)).foregroundStyle(OkouColor.trailingValue)
        }
        OkouIcon("chevron-right", size: OkouIconSize.inline)
          .foregroundStyle(OkouColor.mutedForeground).accessibilityHidden(true)
      }
      .contentShape(Rectangle())
    }.buttonStyle(.plain).disabled(store.isSaving || store.uncertain)
  }

  private func accountCount(_ count: Int) -> Text {
    count == 1 ? Text("1 account") : Text("\(count) accounts")
  }
}

private struct SettingsConnectorDetail: View {
  let store: ComposerConnectorStore
  let resources: ComposerConnectorAccountResources
  @LoadableValue private var catalog: Loadable<ChatCatalogConnector>

  init(store: ComposerConnectorStore, resources: ComposerConnectorAccountResources) {
    self.store = store
    self.resources = resources
    _catalog = LoadableValue(task: resources.catalog)
  }

  var body: some View {
    switch catalog {
    case .loading: ChatSettingsLoadingView(title: "Loading connector…")
    case .hasError(let error):
      List {
        ConnectorLoadError(error: ChatRequestFailure.message(for: error)) {
          resources.retryCatalog()
        }
        NavigationLink("Manage accounts") {
          ComposerConnectorAccounts(store: store, resources: resources)
        }
      }.okouGroupedBackground()

    case .hasData(let connector): ComposerConnectorDetail(store: store, connector: connector)
    }
  }
}
