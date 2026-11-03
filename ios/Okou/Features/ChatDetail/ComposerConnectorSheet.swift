import ChatData
import SwiftUI

struct ComposerConnectorButton: View {
  let store: ComposerConnectorStore
  @State private var presented = false

  var body: some View {
    Button {
      presented = true
    } label: {
      Image(systemName: "powerplug").font(.system(size: 19)).frame(width: 44, height: 44)
    }
    .accessibilityLabel("Connectors")
    .accessibilityIdentifier("composer-connectors")
    .accessibilityValue(store.uncertain ? "Confirm settings before sending" : "")
    .overlay(alignment: .topTrailing) {
      if store.uncertain {
        Image(systemName: "exclamationmark.circle.fill").font(.caption2).foregroundStyle(.orange)
          .accessibilityHidden(true)
      }
    }
    .disabled(store.agentID == nil)
    .sheet(isPresented: $presented) {
      ComposerConnectorSheet(store: store)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
    .onChange(of: store.agentID) { _, _ in presented = false }
  }
}

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
          Text(notice).font(.footnote).foregroundStyle(.secondary)
        }
        Section {
          NavigationLink {
            ComposerRemoteControls(store: store)
          } label: {
            Label("Remote control", systemImage: "desktopcomputer")
          }
        }
        Section {
          if let error = store.connectorError, store.error == nil {
            ConnectorLoadError(error: error, isLoading: store.isLoading) { await store.refresh() }
          } else if store.isLoading && store.connectors.isEmpty && store.error == nil {
            ProgressView("Loading connectors…")
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
              ).foregroundStyle(
                .secondary)
            }
          }
          NavigationLink {
            ComposerConnectorDirectory(store: store)
          } label: {
            Label("Add connectors", systemImage: "plus").foregroundStyle(.primary)
          }
        } header: {
          Text("Services").font(.subheadline).fontWeight(.regular).textCase(nil)
        } footer: {
          Text(
            store.chatAccountAccess
              ? "Account choices apply to this chat."
              : "Service access applies to this Agent. Account choices apply to this chat.")
        }
      }
      .listSectionSpacing(16)
      .searchable(text: $search, prompt: "Find connectors")
      .navigationTitle("Connectors")
      .navigationBarTitleDisplayMode(.inline)
      .navigationDestination(item: $destination) { destination in
        connectorDestination(destination)
      }
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
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

  @ViewBuilder
  private func connectorRow(_ connector: ChatComposerConnector) -> some View {
    if store.chatAccountAccess {
      NavigationLink {
        ComposerChatConnectorAccounts(store: store, connector: connector)
      } label: {
        Label {
          VStack(alignment: .leading, spacing: 4) {
            Text(connector.label).foregroundStyle(.primary).lineLimit(1)
            if let access = connector.access {
              if let account = connector.currentAccount {
                Text("\(account.label) · \(access.enabledCount) enabled")
                  .font(.caption).foregroundStyle(.secondary).lineLimit(1)
              } else {
                Text(access.available ? "Account unavailable" : "Off")
                  .font(.caption).foregroundStyle(.secondary)
              }
            }
          }
        } icon: {
          Image(
            systemName: connector.target.kind == "custom" ? "puzzlepiece.extension" : "powerplug"
          ).foregroundStyle(.secondary)
        }
      }.disabled(store.isSaving)
    } else {
      legacyConnectorRow(connector)
    }
  }

  private func legacyConnectorRow(_ connector: ChatComposerConnector) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        Label(
          connector.label,
          systemImage: connector.target.kind == "custom" ? "puzzlepiece.extension" : "powerplug"
        )
        .lineLimit(1)
        .truncationMode(.tail)
        .layoutPriority(1)
        Spacer(minLength: 8)
        if store.isSaving && savingConnectorID == connector.id {
          ProgressView().controlSize(.small)
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
        .tint(.green)
        .fixedSize(horizontal: true, vertical: false)
        .labelsHidden().disabled(store.isSaving || store.uncertain)
        .accessibilityLabel("Allow \(connector.label) for this Agent")
      }
      .frame(minHeight: 44)
      if connector.authorized && (!connector.managed || connector.hasPermissions) {
        HStack(spacing: 16) {
          if !connector.managed {
            Button {
              destination = .accounts(connector.id)
            } label: {
              HStack(spacing: 4) {
                Text("Account")
                Image(systemName: "chevron.right").font(.caption2)
              }
              .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
              .contentShape(Rectangle())
            }
            .accessibilityLabel("Account for \(connector.label)")
          }
          if connector.hasPermissions && connector.target.connectorSlug != nil {
            Button {
              destination = .permissions(connector.id)
            } label: {
              HStack(spacing: 4) {
                Text("Permissions")
                Image(systemName: "chevron.right").font(.caption2)
              }
              .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
              .contentShape(Rectangle())
            }
            .accessibilityLabel("Permissions for \(connector.label)")
          }
        }
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .buttonStyle(.borderless)
        .padding(.leading, 32)
      }
    }
    .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
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
      ContentUnavailableView(
        "Connector unavailable", systemImage: "powerplug",
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

struct ConnectorLoadError: View {
  let error: String
  var isLoading = false
  let retry: @MainActor () async -> Void
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(error).foregroundStyle(.red).font(.callout)
      Button(isLoading ? "Refreshing…" : "Refresh") { Task { await retry() } }
        .disabled(isLoading)
    }
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
        Section("Cloud Browser") {
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
          .tint(.green)
          .disabled(store.isSaving || store.uncertain || !remotes.cloudBrowserAvailable)
          if !remotes.cloudBrowserAvailable {
            Text("Cloud Browser is not available for this workspace.").font(.footnote)
              .foregroundStyle(.secondary)
          }
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
                  Text("Offline").font(.caption).foregroundStyle(.secondary)
                }
              }
            }
            .toggleStyle(.switch)
            .tint(.green)
            .disabled(store.isSaving || store.uncertain)
          }
          if store.visibleComputerUseHosts.isEmpty {
            Text("No online computers").foregroundStyle(.secondary)
          }
          Button("Connect my computer") { showsDesktopSetup = true }
        } header: {
          Text("Your computer")
        } footer: {
          Text("Choose Cloud Browser or one computer for this chat.")
        }
        ForEach(ChatRemoteProtocol.allCases, id: \.rawValue) { proto in
          Section(proto.rawValue.uppercased()) {
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
              }.disabled(store.isSaving || store.uncertain)
              if proto == .vnc { dependencies(host) }
            }
            Button("Configure \(proto.rawValue.uppercased()) hosts") { store.setupRemote(proto) }
          }
        }
      } else if store.isLoading {
        ProgressView("Loading remote access…")
      }
    }
    .navigationTitle("Remote control")
    .navigationBarTitleDisplayMode(.inline)
    .sheet(isPresented: $showsDesktopSetup) {
      NavigationStack {
        Form {
          Text("Install Okou Desktop on your Mac, connect your account, then reopen Connectors.")
          ShareLink("Share Desktop download link", item: store.service.desktopDownloadURL)
          Link("Download for Mac", destination: store.service.desktopDownloadURL)
        }
        .navigationTitle("Connect my computer")
        .toolbar {
          ToolbarItem(placement: .confirmationAction) {
            Button("Done") { showsDesktopSetup = false }
          }
        }
      }.presentationDetents([.medium])
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
        systemImage: enabled ? "checkmark.circle" : "exclamationmark.triangle"
      )
      .font(.caption).foregroundStyle(enabled ? Color.secondary : Color.orange)
    }
  }
}
