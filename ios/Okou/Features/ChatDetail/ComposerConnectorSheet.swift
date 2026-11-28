import CCState
import CCStateSwiftUI
import ChatData
import SwiftUI

struct ComposerConnectorSheet: View {
  let store: ComposerConnectorStore

  var body: some View {
    // The sheet empties when its owner closes, which the session Store records.
    StoreProvider(store.graph) { ComposerConnectorSheetRoot(store: store) }
  }
}

private struct ComposerConnectorSheetRoot: View {
  let store: ComposerConnectorStore
  @ResolvedValue private var status: ComposerConnectorStore.Status?

  init(store: ComposerConnectorStore) {
    self.store = store
    _status = ResolvedValue(store.statusValue)
  }

  var body: some View {
    if !(status ?? store.status).isClosed, let resources = store.resources {
      StoreProvider(resources.store) {
        ComposerConnectorSheetContent(store: store, resources: resources)
          .id(ObjectIdentifier(resources))
      }
    }
  }
}

private struct ComposerConnectorSheetContent: View {
  let store: ComposerConnectorStore
  let resources: ComposerConnectorResources
  @LoadableValue private var connected: Loadable<[ChatComposerConnector]>
  @LoadableStatus<[ChatComposerConnector]> private var status: LoadableState
  @State private var search = ""
  @State private var accountDestination: ComposerConnectorAccountResources?
  /// The composer's confirmed connectors and remote access, kept in the session Store.
  @ResolvedValue private var resolvedSnapshot: ComposerConnectorStore.Snapshot?
  /// The composer's writes, notices and pushed directory, kept in the same Store.
  @ResolvedValue private var resolvedConnectorStatus: ComposerConnectorStore.Status?
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase

  init(store: ComposerConnectorStore, resources: ComposerConnectorResources) {
    self.store = store
    self.resources = resources
    _connected = LoadableValue(task: resources.connected, keepLast: true)
    _status = LoadableStatus(task: resources.connected)
    _resolvedSnapshot = ResolvedValue(store.snapshotValue)
    _resolvedConnectorStatus = ResolvedValue(store.statusValue)
  }

  private var snapshot: ComposerConnectorStore.Snapshot { resolvedSnapshot ?? store.snapshot }
  private var connectorStatus: ComposerConnectorStore.Status {
    resolvedConnectorStatus ?? store.status
  }

  var body: some View {
    NavigationStack {
      List {
        if let error = connectorStatus.error {
          ConnectorLoadError(error: error, isLoading: connectorStatus.isRefreshing) {
            await store.refresh()
          }
        }
        if let notice = connectorStatus.notice {
          Text(notice).font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
        }
        Section {
          switch connected {
          case .loading where snapshot.connectedServices == nil:
            ComposerConnectorSkeletonRows("Loading connectors…", count: 3)
          case .hasError(let error):
            if connectorStatus.error == nil {
              ConnectorLoadError(
                error: ComposerConnectorResources.message(for: error, in: .connected),
                isLoading: status == .loading
              ) { await store.refresh() }
            }
          case .loading, .hasData:
            // Keep the last confirmed rows visible while reopening or refreshing the sheet.
            ForEach(
              snapshot.connectors.filter {
                search.isEmpty || $0.label.localizedCaseInsensitiveContains(search)
              }
            ) { connector in
              connectorRow(connector)
            }
            if snapshot.connectedServices?.isEmpty == true {
              Text("Connect a service to use it in this chat.")
                .foregroundStyle(OkouColor.mutedForeground)
            }
          }
          Button {
            store.openDirectory()
          } label: {
            HStack {
              OkouRowLabel("Add connectors", okouSymbol: "plus")
              Spacer(minLength: OkouSpace.sm)
              OkouIcon("chevron-right", size: OkouIconSize.inline)
                .foregroundStyle(OkouColor.mutedForeground)
                .accessibilityHidden(true)
            }
          }
        } header: {
          Text("Services").okouSectionHeader()
        }
        ComposerConnectorTools(store: store, resources: resources)
      }
      .listSectionSpacing(OkouSpace.lg)
      .connectorSearch(
        text: $search, enabled: snapshot.connectors.count > 20 || !search.isEmpty,
        prompt: "Find connectors"
      )
      .okouGroupedBackground()
      .navigationTitle("Connectors")
      .navigationBarTitleDisplayMode(.inline)
      .connectorAccountDestination(store: store, destination: $accountDestination)
      .navigationDestination(
        isPresented: Binding(
          get: { connectorStatus.directory != nil },
          set: { if !$0 { store.closeDirectory() } })
      ) {
        if let resources = connectorStatus.directory {
          ComposerConnectorDirectory(store: store, resources: resources)
            .navigationTitle("Add connectors")
            .navigationBarTitleDisplayMode(.inline)
            .id(ObjectIdentifier(resources))
        }
      }
      .toolbar { OkouCloseToolbarItem { dismiss() } }

    }
    .connectorAuthorizationPresentation(store: store)
    .onChange(of: scenePhase) { _, phase in
      if phase == .active { Task { await store.refresh() } }
    }
    .onDisappear {
      store.authorization.cancel()
      store.closeDirectory()
      store.closeAccounts()
      store.closePermissions()
    }
  }

  private func connectorRow(_ connector: ChatComposerConnector) -> some View {
    Button {
      accountDestination?.close()
      accountDestination = store.openAccounts(connector)
    } label: {
      HStack(spacing: OkouSpace.md) {
        ConnectorLogo(
          icon: connector.icon, fallback: connector.target.kind == "custom" ? "puzzle" : "plug"
        )
        .frame(width: OkouControl.rowLeadingSlot, height: OkouControl.rowLeadingSlot)
        VStack(alignment: .leading, spacing: OkouSpace.two) {
          Text(connector.label)
            .font(.okou(.body)).foregroundStyle(OkouColor.foreground).lineLimit(1)
          if connector.access.accounts.count > 1 {
            Text("\(connector.access.accounts.count) accounts")
              .font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground).lineLimit(1)
          }
        }
        Spacer(minLength: OkouSpace.sm)
        OkouIcon("chevron-right", size: OkouIconSize.inline)
          .foregroundStyle(OkouColor.mutedForeground).accessibilityHidden(true)
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(connectorStatus.isSaving)
  }
}

/// A connector read failed: the shared quiet load-error row.
struct ConnectorLoadError: View {
  let error: String
  var isLoading = false
  let retry: @MainActor () async -> Void
  var body: some View {
    OkouLoadErrorRow(message: error, actionTitle: "Refresh", isRetrying: isLoading, retry: retry)
  }
}

/// Account pages retain the parent's current read failure without mirroring it in their Store.
struct ComposerConnectorReadError: View {
  let store: ComposerConnectorStore
  let retry: @MainActor () async -> Void
  /// Whether the owner closed, kept in the session Store.
  @ResolvedValue private var status: ComposerConnectorStore.Status?

  init(store: ComposerConnectorStore, retry: @escaping @MainActor () async -> Void) {
    self.store = store
    self.retry = retry
    _status = ResolvedValue(store.statusValue)
  }

  var body: some View {
    if !(status ?? store.status).isClosed, let resources = store.resources {
      StoreProvider(resources.store) {
        ComposerConnectorReadErrorContent(store: store, resources: resources, retry: retry)
      }
    }
  }
}

private struct ComposerConnectorReadErrorContent: View {
  let store: ComposerConnectorStore
  let retry: @MainActor () async -> Void
  @LoadableValue private var connected: Loadable<[ChatComposerConnector]>
  /// The composer's write failure and refresh, kept in the session Store.
  @ResolvedValue private var connectorStatus: ComposerConnectorStore.Status?

  init(
    store: ComposerConnectorStore, resources: ComposerConnectorResources,
    retry: @escaping @MainActor () async -> Void
  ) {
    self.store = store
    self.retry = retry
    _connected = LoadableValue(task: resources.connected, keepLast: true)
    _connectorStatus = ResolvedValue(store.statusValue)
  }

  var body: some View {
    let current = connectorStatus ?? store.status
    if let error = current.error {
      ConnectorLoadError(error: error, isLoading: current.isRefreshing, retry: retry)
    } else if case .hasError(let error) = connected {
      ConnectorLoadError(
        error: ComposerConnectorResources.message(for: error, in: .connected),
        isLoading: current.isRefreshing, retry: retry)
    }
  }
}

struct ComposerRemoteControls: View {
  let store: ComposerConnectorStore
  @LoadableValue private var remote: Loadable<ComposerConnectorResources.Remote>
  @LoadableStatus<ComposerConnectorResources.Remote> private var status: LoadableState
  @State private var showsDesktopSetup = false
  /// The composer's confirmed connectors and remote access, kept in the session Store.
  @ResolvedValue private var resolvedSnapshot: ComposerConnectorStore.Snapshot?
  /// The composer's writes and a new chat's pending choices, kept in the same Store.
  @ResolvedValue private var resolvedConnectorStatus: ComposerConnectorStore.Status?

  init(store: ComposerConnectorStore, resources: ComposerConnectorResources) {
    self.store = store
    _remote = LoadableValue(task: resources.remote, keepLast: true)
    _status = LoadableStatus(task: resources.remote)
    _resolvedSnapshot = ResolvedValue(store.snapshotValue)
    _resolvedConnectorStatus = ResolvedValue(store.statusValue)
  }

  private var snapshot: ComposerConnectorStore.Snapshot { resolvedSnapshot ?? store.snapshot }
  private var connectorStatus: ComposerConnectorStore.Status {
    resolvedConnectorStatus ?? store.status
  }

  var body: some View {
    Form {
      if let error = connectorStatus.error {
        ConnectorLoadError(error: error, isLoading: connectorStatus.isRefreshing) {
          await store.refresh()
        }
      }
      switch remote {
      case .loading:
        OkouLoadingRow("Loading remote access…")
      case .hasError(let error):
        if connectorStatus.error == nil {
          ConnectorLoadError(
            error: ComposerConnectorResources.message(for: error, in: .remote),
            isLoading: status == .loading
          ) { await store.refresh() }
        }
      case .hasData:
        Section {
          ForEach(store.visibleComputerUseHosts(in: snapshot, status: connectorStatus)) { host in
            Toggle(
              isOn: Binding(
                get: {
                  store.computerAccess(in: snapshot, status: connectorStatus).computerUseHostId
                    == host.id
                },
                set: { enabled in
                  Task {
                    await store.setComputerAccess(
                      ChatComputerAccess(computerUseHostId: enabled ? host.id : nil))
                  }
                })
            ) {
              VStack(alignment: .leading) {
                Text(host.displayName)
                if host.status == "offline" {
                  Text("Offline").font(.okou(.caption)).foregroundStyle(OkouColor.mutedForeground)
                }
              }
            }
            .toggleStyle(.switch)
            .tint(OkouColor.primary400)
            .disabled(!connectorStatus.canSend)
          }
          if store.visibleComputerUseHosts(in: snapshot, status: connectorStatus).isEmpty {
            Text("No online computers").foregroundStyle(OkouColor.mutedForeground)
          }
          Button("Connect my computer") { showsDesktopSetup = true }
        } header: {
          Text("Your computer").okouSectionHeader()
        } footer: {
          Group {
            Text("Choose Cloud Browser or one computer for this chat.")

          }
          .okouSectionNote()
        }
        ForEach(ChatRemoteProtocol.allCases, id: \.rawValue) { proto in
          Section {
            ForEach(snapshot.hosts(proto)) { host in
              Picker(
                host.displayName,
                selection: Binding(
                  get: { choice(host, protocol: proto) },
                  set: { value in
                    Task {
                      await store.setRemote(
                        host, protocol: proto, enabled: value == "default" ? nil : value == "on")
                    }
                  })
              ) {
                Text(host.defaultEnabled ? "Default (on)" : "Default (off)").tag("default")
                Text("On").tag("on")
                Text("Off").tag("off")
              }
              .okouValuePicker()
              .disabled(!connectorStatus.canSend)
              if proto == .vnc { dependencies(host) }
            }
            Button("Configure \(proto.rawValue.uppercased()) hosts") { store.setupRemote(proto) }
          } header: {
            Text(verbatim: proto.rawValue.uppercased()).okouSectionHeader()
          }
        }
      }
    }
    .okouGroupedBackground()
    .navigationTitle("Remote access")
    .navigationBarTitleDisplayMode(.inline)
    .sheet(isPresented: $showsDesktopSetup) {
      ComposerDesktopSetup(store: store)
    }
  }
  private func choice(_ host: ChatRemoteHost, protocol: ChatRemoteProtocol) -> String {
    store.choice(host, protocol: `protocol`, in: connectorStatus).map { $0 ? "on" : "off" }
      ?? "default"
  }
  @ViewBuilder private func dependencies(_ host: ChatRemoteHost) -> some View {
    ForEach(
      snapshot.vncConnections.first(where: { $0.id == host.connectionId })?.sshDependencies ?? [],
      id: \.self
    ) { id in
      let ssh = snapshot.hosts(.ssh).first { $0.connectionId == id }
      let enabled = ssh.map { store.enabled($0, protocol: .ssh, in: connectorStatus) } ?? false
      Label(
        enabled
          ? "SSH enabled: \(ssh?.displayName ?? id)"
          : "Also enable SSH: \(ssh?.displayName ?? "Unavailable host")",
        okouSymbol: enabled ? "circle-check" : "triangle-alert", iconSize: OkouIconSize.inline
      )
      .font(.okou(.caption)).foregroundStyle(
        enabled ? OkouColor.mutedForeground : OkouStatusColor.warning)
    }
  }
}
