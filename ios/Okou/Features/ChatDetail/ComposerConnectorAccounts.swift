import CCState
import CCStateSwiftUI
import ChatData
import SwiftUI

extension View {
  func connectorAccountDestination(
    store: ComposerConnectorStore,
    destination: Binding<ComposerConnectorAccountResources?>
  ) -> some View {
    navigationDestination(
      isPresented: Binding(
        get: { destination.wrappedValue.map { !$0.isClosed } ?? false },
        set: { presented in
          if !presented {
            destination.wrappedValue?.close()
            destination.wrappedValue = nil
          }
        })
    ) {
      if let resources = destination.wrappedValue, !resources.isClosed {
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

  init(store: ComposerConnectorStore, resources: ComposerConnectorAccountResources) {
    self.store = store
    self.resources = resources
    _page = LoadableValue(task: resources.page, keepLast: true)
    _search = LoadableValue(resources.search)
    _pagination = LoadableValue(task: resources.pagination)
    _status = LoadableStatus(task: resources.page)
    _paginationStatus = LoadableStatus(task: resources.pagination)
  }

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
      if let error = store.error ?? store.connectorError {
        ConnectorLoadError(error: error, isLoading: store.isLoading) { await resources.retry() }
      }
      switch page {
      case .loading: EmptyView()
      case .hasError(let error):
        ConnectorLoadError(
          error: ChatRequestFailure.message(for: error),
          isLoading: status == .loading || store.isLoading
        ) { await resources.retry() }
      case .hasData(let value):
        if resources.managesDefaults {
          ComposerConnectorDefaults(store: store, resources: resources, page: value, busy: busy)
        } else if resources.chatAccountAccess {
          ComposerChatConnectorAccounts(
            store: store, resources: resources, page: value, busy: busy, search: search,
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
        } else {
          legacy(value, search: search)
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
    .searchable(
      text: Binding(
        get: { search },
        set: { resources.update(search: $0) }), prompt: "Find accounts"
    )
    .refreshable { await resources.retry() }
    .onChange(of: store.authorization.active?.id) { _, flowID in
      if flowID == nil { Task { await resources.refresh() } }
    }
  }

  private func legacy(_ page: ComposerConnectorAccountResources.Page, search: String) -> some View {
    Section {
      Button {
        Task { await resources.apply(.select(nil)) }
      } label: {
        accountLabel(
          "Use default", detail: page.defaultAccount?.label ?? "No usable default account",
          checked: page.selectedID == nil)
      }.disabled(busy)
      ForEach(page.accounts) { account in
        VStack(alignment: .leading, spacing: OkouSpace.six) {
          Button {
            Task { await resources.apply(.select(account.id)) }
          } label: {
            accountLabel(
              account.label, detail: account.ready ? "Connected" : "Reconnect required",
              checked: page.selectedID == account.id)
          }.disabled(busy)
          if !account.ready {
            Button("Reconnect this account") {
              store.connect(target: resources.connector.target, accountID: account.id)
            }.font(.okou(.footnote)).disabled(busy)
          }
        }
      }
      if let selectedID = page.selectedID, !page.accounts.contains(where: { $0.id == selectedID }) {
        Text("The selected account is unavailable. Choose an account or use default.")
          .font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
      }
      if page.accounts.isEmpty, !search.isEmpty {
        Text("No accounts found").foregroundStyle(OkouColor.mutedForeground)
      }
      accountActions(page: page)
    } footer: {
      Text("This account choice applies to this chat. The default account stays unchanged.")
        .okouSectionNote()
    }
  }

  @ViewBuilder private func accountActions(page: ComposerConnectorAccountResources.Page)
    -> some View
  {
    if page.nextCursor != nil {
      Button("Load more") { Task { await resources.loadMore() } }.disabled(busy)
    }
    Button("Add account") { store.connect(target: resources.connector.target) }.disabled(busy)
  }

  private func accountLabel(_ label: String, detail: String, checked: Bool) -> some View {
    HStack {
      VStack(alignment: .leading, spacing: OkouSpace.three) {
        Text(label).foregroundStyle(OkouColor.foreground)
        Text(detail).font(.okou(.caption)).foregroundStyle(OkouColor.mutedForeground)
      }
      Spacer()
      if checked { OkouIcon("check").foregroundStyle(.tint) }
    }.contentShape(Rectangle())
  }
}
