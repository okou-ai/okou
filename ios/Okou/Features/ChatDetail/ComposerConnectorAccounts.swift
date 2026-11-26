import CCState
import CCStateSwiftUI
import ChatData
import SwiftUI

extension View {
  func connectorAccountDestination(
    store: ComposerConnectorStore,
    destination: Binding<ComposerConnectorAccountResources?>
  ) -> some View {
    modifier(ConnectorAccountDestination(store: store, destination: destination))
  }
}

/// Pushes an account page while it is open. Retiring the page in the workspace session's Store
/// pops it.
private struct ConnectorAccountDestination: ViewModifier {
  let store: ComposerConnectorStore
  @Binding var destination: ComposerConnectorAccountResources?
  @ResolvedValue private var open: Bool?

  init(store: ComposerConnectorStore, destination: Binding<ComposerConnectorAccountResources?>) {
    self.store = store
    _destination = destination
    _open = ResolvedValue(
      destination.wrappedValue?.openValue ?? ComposerConnectorAccountResources.noPage)
  }

  func body(content: Content) -> some View {
    let resources = destination
    // The owner's own flag also closes the page if the graph write did not land.
    let isOpen = resources.map { (open ?? true) && !$0.isClosed } ?? false
    content.navigationDestination(
      isPresented: Binding(
        get: { isOpen },
        set: { presented in
          if !presented {
            destination?.close()
            destination = nil
          }
        })
    ) {
      if let resources, isOpen {
        ComposerConnectorAccounts(store: store, resources: resources)
          .id(ObjectIdentifier(resources))
      }
    }
  }
}

struct ComposerConnectorAccounts: View {
  let store: ComposerConnectorStore
  let resources: ComposerConnectorAccountResources

  var body: some View {
    StoreProvider(resources.store) {
      ComposerConnectorAccountsContent(store: store, resources: resources)
    }
  }
}

private struct ComposerConnectorAccountsContent: View {
  let store: ComposerConnectorStore
  let resources: ComposerConnectorAccountResources
  @State private var permissionDestination: ComposerConnectorPermissionResources?
  @State private var accountDestination: ComposerConnectorAccountResources?
  @LoadableValue private var page: Loadable<ComposerConnectorAccountResources.Page>
  @LoadableValue private var search: Loadable<String>
  @LoadableValue private var pagination: Loadable<Void>
  @LoadableStatus<ComposerConnectorAccountResources.Page> private var status: LoadableState
  @LoadableStatus<Void> private var paginationStatus: LoadableState
  /// The composer's confirmed connectors and remote access, kept in the session Store.
  @ResolvedValue private var resolvedSnapshot: ComposerConnectorStore.Snapshot?
  /// The authorization attempt, kept in the same Store.
  @ResolvedValue private var authorization: ConnectorActionStore.Presentation?

  init(store: ComposerConnectorStore, resources: ComposerConnectorAccountResources) {
    self.store = store
    self.resources = resources
    _page = LoadableValue(task: resources.page, keepLast: true)
    _search = LoadableValue(resources.search)
    _pagination = LoadableValue(task: resources.pagination)
    _status = LoadableStatus(task: resources.page)
    _paginationStatus = LoadableStatus(task: resources.pagination)
    _resolvedSnapshot = ResolvedValue(store.snapshotValue)
    _authorization = ResolvedValue(store.authorization.presentationValue)
  }

  private var snapshot: ComposerConnectorStore.Snapshot { resolvedSnapshot ?? store.snapshot }

  private var busy: Bool {
    status == .loading || paginationStatus == .loading || store.isSaving
      || store.isUpdatingAccounts || store.uncertain
  }

  var body: some View {
    switch search {
    case .hasData(let search): content(search)
    case .loading: OkouLoadingRow("Loading accounts…")
    case .hasError(let error):
      ConnectorLoadError(error: ChatRequestFailure.message(for: error)) { await resources.retry() }
    }
  }

  private func content(_ search: String) -> some View {
    List {
      ComposerConnectorReadError(store: store) { await resources.retry() }
      switch page {
      case .loading: EmptyView()
      case .hasError(let error):
        ConnectorLoadError(
          error: ChatRequestFailure.message(for: error),
          isLoading: status == .loading || store.isRefreshing
        ) { await resources.retry() }
      case .hasData(let value):
        if resources.managesDefaults {
          ComposerConnectorDefaults(store: store, resources: resources, page: value, busy: busy)
        } else {
          ComposerChatConnectorAccounts(
            store: store, resources: resources, page: value, busy: busy, search: search,
            canConfigurePermissions: store.canConfigurePermissions(
              slug: resources.connector.target.connectorSlug, in: snapshot),
            openPermissions: {
              if let slug = resources.connector.target.connectorSlug {
                permissionDestination = store.openPermissions(
                  slug: slug, label: resources.connector.label)
              }
            },
            openManagement: {
              accountDestination?.close()
              accountDestination = store.openAccounts(resources.connector, managesDefaults: true)
            })
        }
      }
      if case .hasError(let error) = pagination {
        ConnectorLoadError(error: ChatRequestFailure.message(for: error), isLoading: busy) {
          await resources.loadMore()
        }
      } else if paginationStatus == .loading {
        OkouLoadingRow("Loading more accounts…")
      }
    }
    .overlay {
      if case .loading = page { ChatSettingsLoadingView(title: "Loading accounts…") }
    }
    .okouGroupedBackground()
    .navigationTitle(
      resources.managesDefaults
        ? Text("Manage accounts") : Text(verbatim: resources.connector.label)
    )
    .navigationBarTitleDisplayMode(.inline)
    .connectorPermissionDestination(store: store, destination: $permissionDestination)
    .connectorAccountDestination(store: store, destination: $accountDestination)
    .connectorSearch(
      text: Binding(get: { search }, set: { resources.update(search: $0) }),
      enabled: accountCount > 6 || !search.isEmpty, prompt: "Find accounts"
    )
    .refreshable { await resources.retry() }
    .onChange(of: (authorization ?? store.authorization.presentation).active?.id) { _, flowID in
      if flowID == nil { Task { await resources.refresh() } }
    }
  }

  private var accountCount: Int {
    if case .hasData(let value) = page { return value.accounts.count }
    return resources.connector.access.accounts.count
  }

}
