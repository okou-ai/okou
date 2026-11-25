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
  @Environment(\.dismiss) private var dismiss
  @State private var confirmsReset = false

  init(store: ComposerConnectorStore, resources: ComposerConnectorPermissionResources) {
    self.store = store
    self.resources = resources
    _page = LoadableValue(task: resources.page, keepLast: true)
    _status = LoadableStatus(task: resources.page)
    _controls = LoadableValue(resources.controls)
  }

  private var busy: Bool { status == .loading || store.isSaving || store.uncertain }

  var body: some View {
    List {
      Section {
        HStack(spacing: OkouSpace.sm) {
          Text("\(resources.label) · All chats and accounts")
            .font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
          Spacer(minLength: 0)
          Button("Reset") { confirmsReset = true }
            .frame(minHeight: OkouControl.minimumTarget).disabled(busy)
        }
      }
      ComposerConnectorReadError(store: store) { await resources.retry() }
      if let notice = store.notice {
        Text(notice).font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
      }
      if case .hasData(let controls) = controls,
        let failure = controls.confirmationFailure, store.error == nil
      {
        ConnectorLoadError(error: failure, isLoading: store.isRefreshing) {
          await resources.retry()
        }
      }
      switch page {
      case .loading: OkouLoadingRow("Loading permissions…")
      case .hasError(let error):
        ConnectorLoadError(error: ChatRequestFailure.message(for: error)) {
          await resources.retry()
        }
      case .hasData(let value):
        if case .hasData(let controls) = controls {
          permissionControls(controls.selection)
        }
        Section {
          ForEach(categories(value), id: \.self) { category in
            let names = permissions(value, category: category).map(\.name)
            NavigationLink {
              ComposerPermissionGroup(
                composer: store, resources: resources, category: category)
            } label: {
              OkouValueRow(value: Text(value.summary(for: names))) {
                Text(category)
              }
            }
          }
        } header: {
          Text("Permissions").okouSectionHeader()
        }
        Section {
          ComposerPermissionRow(
            name: "__unknown__", description: nil, page: value, resources: resources, busy: busy)
        } header: {
          Text("Unknown operations").okouSectionHeader()
        }
      }
    }
    .okouGroupedBackground()
    .listSectionSpacing(OkouSpace.lg)
    .navigationTitle("Permissions")
    .navigationBarTitleDisplayMode(.inline)
    .searchable(text: search, prompt: "Find permissions")
    .safeAreaInset(edge: .bottom) { actions }
    .alert("Reset permissions?", isPresented: $confirmsReset) {
      Button("Cancel", role: .cancel) {}
      Button("Reset", role: .destructive) { Task { await resources.apply(.reset) } }
    } message: {
      Text("Apply to save.")
    }
  }

  private func categories(_ page: ComposerConnectorPermissionResources.Page) -> [String] {
    let names = Set(
      page.permissions.map {
        page.state.metadata.categories?.categories[$0.name] ?? String(localized: "Other")
      })
    let ordered = page.state.metadata.categories?.displayOrder ?? []
    return ordered.filter { names.contains($0) } + names.subtracting(ordered).sorted()
  }

  private func permissions(
    _ page: ComposerConnectorPermissionResources.Page, category: String
  ) -> [ChatPermissionMetadata.Permission] {
    page.permissions.filter {
      (page.state.metadata.categories?.categories[$0.name] ?? String(localized: "Other"))
        == category
    }
  }

  private func permissionControls(
    _ selection: ComposerConnectorPermissionResources.Selection
  ) -> some View {
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
      }.okouValuePicker().disabled(busy)
      Menu("Set all permissions") {
        Button("Allow all") { Task { await resources.apply(.allowListed) } }
        Button("Deny all") { Task { await resources.apply(.denyListed) } }
      }.disabled(busy)
    }
  }

  private var actions: some View {
    HStack(spacing: OkouSpace.md) {
      Button("Cancel") { dismiss() }
        .buttonStyle(OkouButtonStyle(isPrimary: false, isCompact: true))
        .disabled(store.isSaving)
      Button {
        Task { if await resources.save() { dismiss() } }
      } label: {
        HStack {
          if store.isSaving { ProgressView() }
          Text("Apply")
        }.frame(maxWidth: .infinity)
      }
      .buttonStyle(OkouButtonStyle(isPrimary: true, isCompact: true))
      .disabled(busy || !hasChanges)
    }
    .padding(.horizontal, OkouSpace.lg).padding(.vertical, OkouSpace.sm)
    .background(OkouColor.background)
  }

  private var hasChanges: Bool {
    if case .hasData(let value) = controls { return value.hasChanges }
    return false
  }

  private var search: Binding<String> {
    Binding(
      get: {
        if case .hasData(let value) = controls { return value.selection.search }
        return ""
      },
      set: { resources.update(search: $0) })
  }
}

private struct ComposerPermissionGroup: View {
  let composer: ComposerConnectorStore
  let resources: ComposerConnectorPermissionResources
  let category: String
  @LoadableValue private var page: Loadable<ComposerConnectorPermissionResources.Page>

  init(
    composer: ComposerConnectorStore, resources: ComposerConnectorPermissionResources,
    category: String
  ) {
    self.composer = composer
    self.resources = resources
    self.category = category
    _page = LoadableValue(task: resources.page, keepLast: true)
  }

  var body: some View {
    List {
      if case .hasData(let value) = page {
        let permissions = value.permissions.filter {
          (value.state.metadata.categories?.categories[$0.name] ?? String(localized: "Other"))
            == category
        }
        Section {
          Menu("Set category") {
            Button("Allow all") {
              Task { await resources.apply(.allowGroup(permissions.map(\.name))) }
            }
            Button("Deny all") {
              Task { await resources.apply(.denyGroup(permissions.map(\.name))) }
            }
          }.disabled(composer.isSaving || composer.uncertain)
        } footer: {
          Text("Apply on the Permissions page to save.").okouSectionNote()
        }
        Section {
          ForEach(permissions, id: \.name) { permission in
            ComposerPermissionRow(
              name: permission.name, description: permission.description, page: value,
              resources: resources, busy: composer.isSaving || composer.uncertain)
          }
        }
      }
    }
    .okouGroupedBackground().navigationTitle(category).navigationBarTitleDisplayMode(.inline)
  }
}

private struct ComposerPermissionRow: View {
  let name: String
  let description: String?
  let page: ComposerConnectorPermissionResources.Page
  let resources: ComposerConnectorPermissionResources
  let busy: Bool

  var body: some View {
    HStack(spacing: OkouSpace.md) {
      VStack(alignment: .leading, spacing: OkouSpace.xs) {
        Text(name == "__unknown__" ? String(localized: "Unknown operations") : name)
          .font(.okou(.callout))
        if let description {
          Text(description).font(.okou(.caption)).foregroundStyle(OkouColor.mutedForeground)
        }
        if let expiry = page.expiry(for: name) {
          Text(expiry).font(.okou(.caption)).foregroundStyle(OkouColor.mutedForeground)
        }
      }
      Spacer(minLength: 0)
      Menu {
        Button("Allow") { Task { await resources.apply(.allow(name)) } }
        Button("Deny") { Task { await resources.apply(.deny(name)) } }
      } label: {
        Text(page.policy(for: name).rawValue.capitalized)
          .frame(minHeight: OkouControl.minimumTarget)
      }.disabled(busy)
    }
  }
}
