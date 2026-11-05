import ChatData
import SwiftUI

struct ComposerConnectorAccounts: View {
  let store: ComposerConnectorStore
  let connector: ChatComposerConnector
  var body: some View {
    if store.chatAccountAccess {
      ComposerChatConnectorAccounts(store: store, connector: connector)
    } else {
      LegacyComposerConnectorAccounts(store: store, connector: connector)
    }
  }
}

private struct LegacyComposerConnectorAccounts: View {
  let store: ComposerConnectorStore
  let connector: ChatComposerConnector
  @State private var accounts: [ChatConnectorAccount] = []
  @State private var defaultAccount: ChatConnectorAccount?
  @State private var selection: String?
  @State private var cursor: String?
  @State private var search = ""
  @State private var error: String?
  @State private var loading = false
  @State private var requestID = UUID()

  var body: some View {
    List {
      if let error {
        ConnectorLoadError(error: error, isLoading: loading || store.isLoading) {
          await store.refresh()
          await load()
        }
      }
      Section {
        Button {
          Task { await choose(nil) }
        } label: {
          accountLabel(
            "Use default", detail: defaultAccount?.label ?? "No usable default account",
            checked: selection == nil)
        }.disabled(store.isSaving || store.uncertain || loading)
        ForEach(accounts) { account in
          VStack(alignment: .leading, spacing: OkouSpace.six) {
            Button {
              Task { await choose(account.id) }
            } label: {
              accountLabel(
                account.label,
                detail: account.ready ? "Connected" : "Reconnect required",
                checked: selection == account.id)
            }.disabled(store.isSaving || store.uncertain || loading)
            if !account.ready {
              Button("Reconnect this account") {
                store.connect(target: connector.target, accountID: account.id)
              }
              .font(.okou(.footnote)).disabled(store.isSaving)
            }
          }
        }
        if !loading, selection != nil, !accounts.contains(where: { $0.id == selection }) {
          Text("The selected account is unavailable. Choose an account or use default.")
            .font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
        }
        if !loading, accounts.isEmpty, !search.isEmpty {
          Text("No accounts found").foregroundStyle(OkouColor.mutedForeground)
        }
        if let cursor {
          Button("Load more") { Task { await load(cursor: cursor) } }.disabled(
            loading || store.isSaving)
        }
        Button("Add account") { store.connect(target: connector.target) }.disabled(store.isSaving)
      } footer: {
        Group {
          Text("This account choice applies to this chat. The default account stays unchanged.")

        }
        .okouSectionNote()
      }
    }
    .overlay {
      if loading && accounts.isEmpty && defaultAccount == nil && error == nil {
        ChatSettingsLoadingView(title: "Loading accounts…")
      }
    }
    .searchable(text: $search, prompt: "Find accounts")
    .okouGroupedBackground()
    .navigationTitle(connector.label)
    .navigationBarTitleDisplayMode(.inline)
    .task(id: search) { await load() }
    .refreshable { await load() }
    .onChange(of: store.authorization.active?.id) { _, flowID in
      if flowID == nil { Task { await load() } }
    }
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

  private func load(cursor: String? = nil) async {
    guard !store.isSaving else { return }
    let request = UUID()
    requestID = request
    loading = true
    defer { if requestID == request { loading = false } }
    do {
      let page = try await store.service.accounts(
        target: connector.target, search: search, cursor: cursor)
      let selected: ChatConnectorSelection?
      var explicitAccount: ChatConnectorAccount?
      if let threadID = store.threadID {
        let preferences = try await store.service.preferences(threadID: threadID)
        selected = preferences.selections.first { $0.target == connector.target }
        explicitAccount = preferences.selectedConnections.first { $0.id == selected?.connectionId }
      } else {
        selected = store.pendingOptions.connectorSelections.first { $0.target == connector.target }
      }
      guard !Task.isCancelled, requestID == request else { return }
      var values = cursor == nil ? page.connections : accounts + page.connections
      if let explicitAccount, !values.contains(where: { $0.id == explicitAccount.id }) {
        values.insert(explicitAccount, at: 0)
      }
      accounts = values
      defaultAccount = page.defaultConnection
      self.cursor = page.nextCursor
      selection = selected?.connectionId
      error = nil
    } catch is CancellationError {
    } catch {
      guard requestID == request else { return }
      self.error = ChatRequestFailure.message(for: error)
    }
  }
  private func choose(_ id: String?) async {
    await store.selectAccount(target: connector.target, connectionID: id)
    if !store.uncertain {
      await load()
    } else {
      error = store.error ?? "Refresh Connectors to confirm the saved choice."
    }
  }
}
