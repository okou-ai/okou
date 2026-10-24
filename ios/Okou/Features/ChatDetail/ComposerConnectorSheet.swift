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
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    NavigationStack {
      List {
        if let error = store.error { ConnectorLoadError(error: error) { await store.refresh() } }
        Section {
          if let error = store.connectorError {
            ConnectorLoadError(error: error) { await store.refresh() }
          } else if store.isLoading && store.connectors.isEmpty {
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
              Text("Connect a service to make it available to this Agent.").foregroundStyle(
                .secondary)
            }
          }
          NavigationLink {
            ComposerConnectorDirectory(store: store)
          } label: {
            Label("Add connectors", systemImage: "plus")
          }
        } header: {
          Text("Services")
        } footer: {
          Text("Service access applies to this Agent. Account choices apply to this conversation.")
        }
        Section {
          NavigationLink {
            ComposerRemoteControls(store: store)
          } label: {
            Label("Remote control", systemImage: "desktopcomputer")
          }
        }
      }
      .searchable(text: $search, prompt: "Find connectors")
      .navigationTitle("Connectors")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
      .task { await store.refresh() }
      .refreshable { await store.refresh() }
      .onChange(of: scenePhase) { _, phase in
        if phase == .active { Task { await store.refresh() } }
      }
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
    .onDisappear { store.authorization.cancel() }
  }

  private func connectorRow(_ connector: ChatComposerConnector) -> some View {
    HStack {
      Label(
        connector.label,
        systemImage: connector.target.kind == "custom" ? "puzzlepiece.extension" : "powerplug")
      Spacer(minLength: 8)
      if connector.authorized && !connector.managed {
        NavigationLink {
          ComposerConnectorAccounts(store: store, connector: connector)
        } label: {
          Image(systemName: "person.crop.circle").frame(minWidth: 36, minHeight: 44)
        }
        .accessibilityLabel("Account for \(connector.label)")
        .buttonStyle(.plain)
      }
      if connector.authorized && connector.hasPermissions, let slug = connector.target.connectorSlug
      {
        NavigationLink {
          ComposerConnectorPermissions(store: store, slug: slug, label: connector.label)
        } label: {
          Image(systemName: "slider.horizontal.3").frame(minWidth: 36, minHeight: 44)
        }
        .accessibilityLabel("Permissions for \(connector.label)")
        .buttonStyle(.plain)
      }
      Toggle(
        connector.label,
        isOn: Binding(
          get: { connector.authorized },
          set: { enabled in
            if enabled && connector.permissionBundleRef != nil {
              store.openWeb(path: "connectors")
            } else {
              Task { await store.setAuthorized(connector, enabled: enabled) }
            }
          })
      )
      .labelsHidden().disabled(store.isSaving)
      .accessibilityLabel("Allow \(connector.label) for this Agent")
    }
  }
}

struct ConnectorLoadError: View {
  let error: String
  let retry: @MainActor () async -> Void
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(error).foregroundStyle(.red).font(.callout)
      Button("Refresh") { Task { await retry() } }
    }
  }
}

private struct ComposerRemoteControls: View {
  @Bindable var store: ComposerConnectorStore
  @State private var showsDesktopSetup = false

  var body: some View {
    Form {
      if let error = store.error ?? store.remoteError {
        ConnectorLoadError(error: error) { await store.refresh() }
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
          .disabled(store.isSaving || !remotes.cloudBrowserAvailable)
          if !remotes.cloudBrowserAvailable {
            Text("Cloud Browser is not available for this workspace.").font(.footnote)
              .foregroundStyle(.secondary)
          }
        }
        Section {
          ForEach(remotes.computerUseHosts) { host in
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
            }.disabled(store.isSaving)
          }
          if remotes.computerUseHosts.isEmpty {
            Text("No computers connected").foregroundStyle(.secondary)
          }
          Button("Connect my computer") { showsDesktopSetup = true }
        } header: {
          Text("Your computer")
        } footer: {
          Text("Choose Cloud Browser or one computer for this conversation.")
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
              }.disabled(store.isSaving)
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
          Text(
            "Install Okou Desktop on your Mac, connect your account, then return here and refresh.")
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
