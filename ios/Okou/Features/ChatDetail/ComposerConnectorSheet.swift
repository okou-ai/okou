import ChatData
import SwiftUI

struct ComposerConnectorSheet: View {
  @Bindable var store: ComposerConnectorStore
  @State private var search = ""
  @State private var destination: ConnectorDestination?
  @State private var savingConnectorID: String?
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    NavigationStack {
      List {
        if let error = store.error {
          ConnectorLoadError(error: error, isLoading: store.isLoading) { await store.refresh() }
        }
        if let notice = store.notice {
          Text(notice).font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
        }
        Section {
          NavigationLink {
            ComposerRemoteControls(store: store)
          } label: {
            OkouRowLabel("Remote control", okouSymbol: "monitor")
          }
        }
        Section {
          if let error = store.connectorError, store.error == nil {
            ConnectorLoadError(error: error, isLoading: store.isLoading) { await store.refresh() }
          } else if store.isLoading && store.connectors.isEmpty && store.error == nil {
            OkouLoadingRow("Loading connectors…")
          } else {
            ForEach(
              store.connectors.filter {
                search.isEmpty || $0.label.localizedCaseInsensitiveContains(search)
              }
            ) { connector in
              connectorRow(connector)
            }
            if store.connectors.isEmpty && !store.isLoading {
              Text(
                store.chatAccountAccess
                  ? "Connect a service to use it in this chat."
                  : "Connect a service to make it available to this Agent."
              )
              .foregroundStyle(OkouColor.mutedForeground)
            }
          }
          NavigationLink {
            ComposerConnectorDirectory(store: store)
          } label: {
            OkouRowLabel("Add connectors", okouSymbol: "plus")
          }
        } header: {
          // The rule belongs above the switches it explains, not under a long list.
          VStack(alignment: .leading, spacing: OkouSpace.two) {
            Text("Services").okouSectionHeader()
            Group {
              if store.chatAccountAccess {
                Text("Account choices apply to this chat.")
              } else {
                Text("Switches apply to this Agent. Account choices apply to this chat.")
              }
            }
            .font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
            .textCase(nil)
          }
        }
      }
      .listSectionSpacing(16)
      .searchable(text: $search, prompt: "Find connectors")
      .okouGroupedBackground()
      .navigationTitle("Connectors")
      .navigationBarTitleDisplayMode(.inline)
      .navigationDestination(item: $destination) { destination in
        connectorDestination(destination)
      }
      .toolbar { OkouCloseToolbarItem { dismiss() } }
      .alert(
        "Could not open connector",
        isPresented: Binding(
          get: { store.authorization.activationError != nil },
          set: { if !$0 { store.authorization.activationError = nil } })
      ) {
        Button("OK") { store.authorization.activationError = nil }
      } message: {
        Text(store.authorization.activationError ?? "")
      }
      .sheet(
        item: Binding(
          get: { store.authorization.active },
          set: { if $0 == nil { store.authorization.cancel() } })
      ) { flow in
        ConnectorAuthorizationSheet(flow: flow, store: store.authorization)
          .okouSheetBackground()
      }
      .sheet(item: $store.webDestination, onDismiss: { Task { await store.refresh() } }) { page in
        ConnectorSafariView(url: page.url) { store.webDestination = nil }
      }
    }
    // Loading belongs to the sheet, including its pushed destinations.
    .task { await store.refresh() }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active { Task { await store.refresh() } }
    }
    .onDisappear { store.authorization.cancel() }
  }

  /// With chat account access a service opens the accounts this chat may use; otherwise it
  /// is a switch for this Agent with account and permission shortcuts.
  @ViewBuilder
  private func connectorRow(_ connector: ChatComposerConnector) -> some View {
    if store.chatAccountAccess {
      NavigationLink {
        ComposerChatConnectorAccounts(store: store, connector: connector)
      } label: {
        HStack(spacing: OkouSpace.md) {
          ConnectorLogo(
            icon: connector.icon, fallback: connector.target.kind == "custom" ? "puzzle" : "plug"
          )
          .frame(width: OkouControl.rowLeadingSlot, height: OkouControl.rowLeadingSlot)
          VStack(alignment: .leading, spacing: OkouSpace.two) {
            Text(connector.label)
              .font(.okou(.body)).foregroundStyle(OkouColor.foreground).lineLimit(1)
            if let access = connector.access {
              Group {
                if let account = connector.currentAccount {
                  Text("\(account.label) · \(access.enabledCount) enabled")
                } else if access.available {
                  Text("Account unavailable")
                } else {
                  Text("Off")
                }
              }
              .font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground).lineLimit(1)
            }
          }
        }
      }
      .disabled(store.isSaving)
    } else {
      legacyConnectorRow(connector)
    }
  }

  /// One line per service: its logo and name, account and permission shortcuts once it is
  /// allowed, and the switch that allows it for this Agent.
  private func legacyConnectorRow(_ connector: ChatComposerConnector) -> some View {
    HStack(spacing: OkouSpace.md) {
      OkouRowLabel(
        Text(connector.label)
      ) {
        ConnectorLogo(
          icon: connector.icon, fallback: connector.target.kind == "custom" ? "puzzle" : "plug")
      }
      .lineLimit(1)
      .truncationMode(.tail)
      .layoutPriority(1)
      Spacer(minLength: OkouSpace.sm)
      if store.isSaving && savingConnectorID == connector.id {
        ProgressView().controlSize(.small).tint(OkouColor.mutedForeground)
      }
      if connector.authorized && !connector.managed {
        rowAction("circle-user-round", label: "Account for \(connector.label)") {
          destination = .accounts(connector.id)
        }
      }
      if connector.authorized && connector.hasPermissions && connector.target.connectorSlug != nil {
        rowAction("sliders-horizontal", label: "Permissions for \(connector.label)") {
          destination = .permissions(connector.id)
        }
      }
      Toggle(
        connector.label,
        isOn: Binding(
          get: { connector.authorized },
          set: { enabled in
            if enabled && connector.permissionBundleRef != nil {
              store.openWeb(path: "connectors")
            } else {
              Task {
                guard !store.isSaving, !store.uncertain else { return }
                savingConnectorID = connector.id
                defer { savingConnectorID = nil }
                await store.setAuthorized(connector, enabled: enabled)
              }
            }
          })
      )
      .toggleStyle(.switch)
      .tint(OkouColor.primary400)
      .fixedSize(horizontal: true, vertical: false)
      .labelsHidden().disabled(store.isSaving || store.uncertain)
      .accessibilityLabel("Allow \(connector.label) for this Agent")
    }
    .listRowInsets(.vertical, OkouSpace.xs)
  }

  private func rowAction(
    _ icon: String, label: LocalizedStringKey, action: @escaping () -> Void
  ) -> some View {
    Button(action: action) {
      OkouIcon(icon, size: OkouIconSize.standard)
        .foregroundStyle(OkouColor.mutedForeground)
        .frame(width: OkouControl.inlineActionHeight, height: OkouControl.inlineActionHeight)
        .contentShape(Rectangle())
    }
    .buttonStyle(.borderless)
    .accessibilityLabel(label)
  }

  @ViewBuilder
  private func connectorDestination(_ destination: ConnectorDestination) -> some View {
    if let connector = store.connectors.first(where: { $0.id == destination.connectorID }) {
      switch destination {
      case .accounts:
        ComposerConnectorAccounts(store: store, connector: connector)
      case .permissions:
        if let slug = connector.target.connectorSlug {
          ComposerConnectorPermissions(store: store, slug: slug, label: connector.label)
        }
      }
    } else {
      OkouEmptyState(
        "Connector unavailable", icon: "plug",
        description: Text("Return to Connectors to choose an available service."))
    }
  }

  private enum ConnectorDestination: Hashable {
    case accounts(String)
    case permissions(String)

    var connectorID: String {
      switch self {
      case .accounts(let id), .permissions(let id): id
      }
    }
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

private struct ComposerRemoteControls: View {
  @Bindable var store: ComposerConnectorStore
  @State private var showsDesktopSetup = false

  var body: some View {
    Form {
      if let error = store.error ?? store.remoteError {
        ConnectorLoadError(error: error, isLoading: store.isLoading) { await store.refresh() }
      }
      if let remotes = store.remotes, store.remoteError == nil {
        Section {
          Toggle(
            "Cloud Browser",
            isOn: Binding(
              get: { store.computerAccess.cloudBrowserEnabled },
              set: { enabled in
                Task {
                  await store.setComputerAccess(ChatComputerAccess(cloudBrowserEnabled: enabled))
                }
              })
          )
          .toggleStyle(.switch)
          .tint(OkouColor.primary400)
          .disabled(store.isSaving || store.uncertain || !remotes.cloudBrowserAvailable)
        } header: {
          Text("Cloud Browser").okouSectionHeader()
        } footer: {
          Group {
            if !remotes.cloudBrowserAvailable {
              Text("Cloud Browser is not available for this workspace.")
            }

          }
          .okouSectionNote()
        }
        Section {
          ForEach(store.visibleComputerUseHosts) { host in
            Toggle(
              isOn: Binding(
                get: { store.computerAccess.computerUseHostId == host.id },
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
            .disabled(store.isSaving || store.uncertain)
          }
          if store.visibleComputerUseHosts.isEmpty {
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
            ForEach(store.hosts(proto)) { host in
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
              .disabled(store.isSaving || store.uncertain)
              if proto == .vnc { dependencies(host) }
            }
            Button("Configure \(proto.rawValue.uppercased()) hosts") { store.setupRemote(proto) }
          } header: {
            Text(verbatim: proto.rawValue.uppercased()).okouSectionHeader()
          }
        }
      } else if store.isLoading {
        OkouLoadingRow("Loading remote access…")
      }
    }
    .okouGroupedBackground()
    .navigationTitle("Computers & browser")
    .navigationBarTitleDisplayMode(.inline)
    .sheet(isPresented: $showsDesktopSetup) {
      NavigationStack {
        Form {
          Text("Install Okou Desktop on your Mac, connect your account, then reopen Connectors.")
          ShareLink("Share Desktop download link", item: store.service.desktopDownloadURL)
          Link("Download for Mac", destination: store.service.desktopDownloadURL)
        }
        .okouGroupedBackground()
        .navigationTitle("Connect my computer")
        .toolbar { OkouCloseToolbarItem { showsDesktopSetup = false } }
      }
      .presentationDetents([.medium])
      .okouSheetBackground()
    }
  }
  private func choice(_ host: ChatRemoteHost, protocol: ChatRemoteProtocol) -> String {
    store.choice(host, protocol: `protocol`).map { $0 ? "on" : "off" } ?? "default"
  }
  @ViewBuilder private func dependencies(_ host: ChatRemoteHost) -> some View {
    ForEach(
      store.vncConnections.first(where: { $0.id == host.connectionId })?.sshDependencies ?? [],
      id: \.self
    ) { id in
      let ssh = store.hosts(.ssh).first { $0.connectionId == id }
      let enabled = ssh.map { store.enabled($0, protocol: .ssh) } ?? false
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
