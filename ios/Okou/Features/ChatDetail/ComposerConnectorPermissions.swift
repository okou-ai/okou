import CCState
import CCStateSwiftUI
import ChatData
import SwiftUI

extension View {
  func connectorPermissionDestination(
    store: ComposerConnectorStore,
    destination: Binding<ComposerConnectorPermissionResources?>
  ) -> some View {
    modifier(ConnectorPermissionDestination(store: store, destination: destination))
  }
}

/// Each entry owns its navigation binding; the composer owns the resource lifetime.
private struct ConnectorPermissionDestination: ViewModifier {
  let store: ComposerConnectorStore
  @Binding var destination: ComposerConnectorPermissionResources?

  func body(content: Content) -> some View {
    content.navigationDestination(
      isPresented: Binding(
        get: { destination != nil && store.permissions === destination },
        set: { presented in
          if !presented {
            if store.permissions === destination { store.closePermissions() }
            destination = nil
          }
        })
    ) {
      if let resources = destination, store.permissions === resources {
        ComposerConnectorPermissions(store: store, resources: resources)
          .id(ObjectIdentifier(resources))
      }
    }
  }
}

struct ComposerConnectorPermissions: View {
  let store: ComposerConnectorStore
  let resources: ComposerConnectorPermissionResources

  var body: some View {
    StoreProvider(resources.store) {
      ComposerConnectorPermissionsContent(store: store, resources: resources)
    }
  }
}

private struct ComposerConnectorPermissionsContent: View {
  let store: ComposerConnectorStore
  let resources: ComposerConnectorPermissionResources
  @LoadableValue private var page: Loadable<ComposerConnectorPermissionResources.Page>
  @LoadableValue private var controls: Loadable<ComposerConnectorPermissionResources.Controls>
  @LoadableStatus<ComposerConnectorPermissionResources.Page> private var status: LoadableState
  @State private var confirmsReset = false

  init(store: ComposerConnectorStore, resources: ComposerConnectorPermissionResources) {
    self.store = store
    self.resources = resources
    _page = LoadableValue(task: resources.page, keepLast: true)
    _status = LoadableStatus(task: resources.page)
    _controls = LoadableValue(resources.controls)
  }

  private var loading: Bool { status == .loading || store.isSaving }
  private var busy: Bool { loading || store.uncertain }

  var body: some View {
    switch controls {
    case .hasData(let value): content(value)
    case .loading: OkouLoadingRow("Loading permissions…")
    case .hasError(let error):
      ConnectorLoadError(error: ChatRequestFailure.message(for: error)) { await resources.retry() }
    }
  }

  private func content(_ controls: ComposerConnectorPermissionResources.Controls) -> some View {
    let selection = controls.selection
    return List {
      if let failure = controls.confirmationFailure {
        ConnectorLoadError(error: failure, isLoading: loading || store.isRefreshing) {
          await resources.retry()
        }
      }
      if case .hasError(let error) = page {
        ConnectorLoadError(
          error: ChatRequestFailure.message(for: error), isLoading: loading || store.isRefreshing
        ) {
          await resources.retry()
        }
      }
      if case .hasData(let value) = page {
        let state = value.state
        Section {
          Picker(
            "Allow for",
            selection: Binding(
              get: { selection.duration }, set: { resources.update(duration: $0) })
          ) {
            Text("1 hour").tag("1h")
            Text("24 hours").tag("24h")
            Text("7 days").tag("7d")
            Text("Always").tag("always")
          }
          .okouValuePicker()
          if let categories = state.metadata.categories {
            Picker(
              "Category",
              selection: Binding(
                get: { selection.category }, set: { resources.update(category: $0) })
            ) {
              Text("All categories").tag("")
              ForEach(categories.displayOrder, id: \.self) { Text($0).tag($0) }
            }
            .okouValuePicker()
          }
          Menu("Set listed permissions") {
            Button("Allow all") {
              Task { await resources.apply(.allowListed) }
            }
            Button("Deny all") {
              Task { await resources.apply(.denyListed) }
            }
          }.disabled(
            busy || value.permissions.isEmpty)
        } footer: {
          Text(
            state.connectorScoped
              ? "These permissions apply to this connector across your chats and accounts."
              : "These permissions apply to this Agent across its chats."
          )
          .okouSectionNote()
        }
        Section {
          ForEach(value.permissions, id: \.name) { permission in
            permissionRow(permission.name, description: permission.description, state: state)
          }
        } header: {
          Text("Permissions").okouSectionHeader()
        }
        Section {
          permissionRow(
            "__unknown__", description: "Requests not recognized by the connector", state: state)
        } header: {
          Text("Unknown operations").okouSectionHeader()
        }
        Section {
          Button("Reset to defaults", role: .destructive) { confirmsReset = true }.disabled(
            busy)
        } footer: {
          Group {
            Text(
              "Reset removes this connector's explicit grants and restores its default allow, ask, or deny rules."
            )

          }
          .okouSectionNote()
        }
      }
    }
    .okouGroupedBackground()
    .listSectionSpacing(OkouSpace.lg)
    .overlay {
      if case .loading = page {
        ChatSettingsLoadingView(title: "Loading permissions…")
      }
    }
    .navigationTitle(resources.label + " permissions")
    .navigationBarTitleDisplayMode(.inline)
    .searchable(
      text: Binding(get: { selection.search }, set: { resources.update(search: $0) }),
      prompt: "Find permissions"
    )
    .confirmationDialog(
      connectorScoped
        ? "Reset this connector's permissions?"
        : "Reset this connector's permissions for this Agent?", isPresented: $confirmsReset
    ) {
      Button("Reset to defaults", role: .destructive) { Task { await resources.apply(.reset) } }
        .disabled(busy)
    }
  }
  private var connectorScoped: Bool {
    if case .hasData(let value) = page { return value.state.connectorScoped }
    return false
  }

  private func permissionRow(
    _ name: String, description: String?, state: ChatConnectorPermissionState
  ) -> some View {
    let policy = state.metadata.policy(for: name, grants: state.grants, at: .now)
    return HStack(alignment: .top) {
      VStack(alignment: .leading, spacing: 5) {
        Text(name == "__unknown__" ? "Unknown operations" : name).font(.okou(.callout))
        if let description {
          Text(description).font(.okou(.caption)).foregroundStyle(OkouColor.mutedForeground)
        }
        if let expiry = state.grants.last(where: { $0.permission == name && $0.isActive(at: .now) }
        )?.expiresAt {
          Text("Expires \(expiry.formatted(date: .abbreviated, time: .shortened))").font(
            .okou(.caption)
          )
          .foregroundStyle(OkouColor.mutedForeground)
        }
      }
      Spacer()
      Menu {
        Button("Allow") {
          Task { await resources.apply(.allow(name)) }
        }
        Button("Deny") {
          Task { await resources.apply(.deny(name)) }
        }
      } label: {
        Text(policy.rawValue.capitalized).frame(minHeight: OkouControl.minimumTarget)
      }.disabled(busy)
    }
  }
}
