import ChatData
import SwiftUI

private enum ConnectorAccountChoice: String {
  case inherited, on, off
  init(_ value: Bool?) {
    self = value.map { $0 ? .on : .off } ?? .inherited
  }
  var enabled: Bool? {
    switch self {
    case .inherited: nil
    case .on: true
    case .off: false
    }
  }
}

struct ComposerChatConnectorAccounts: View {
  let store: ComposerConnectorStore
  let connector: ChatComposerConnector
  @State private var permissionDestination: ComposerConnectorPermissionResources?
  @State private var accounts: [ChatConnectorAccount] = []
  @State private var cursor: String?
  @State private var search = ""
  @State private var error: String?
  @State private var loading = false
  @State private var requestID = UUID()

  private var current: ChatComposerConnector? {
    store.connectors.first { $0.target == connector.target }
  }
  private var displayed: [ChatConnectorAccount] {
    if search.isEmpty, let account = current?.currentAccount,
      !accounts.contains(where: { $0.id == account.id })
    {
      return [account] + accounts
    }
    return accounts
  }
  private var busy: Bool { loading || store.isSaving || store.uncertain }

  var body: some View {
    List {
      if let error = error ?? store.error ?? store.connectorError {
        ConnectorLoadError(error: error, isLoading: loading || store.isLoading) {
          await store.refresh()
          await load()
        }
      }
      Section {
        ForEach(displayed) { account in
          if let access = current?.access?.accounts.first(where: { $0.connectionId == account.id })
          {
            accountRow(account, access: access)
          }
        }
        if !loading, displayed.isEmpty {
          Text(search.isEmpty ? "No saved accounts" : "No accounts found")
            .foregroundStyle(.secondary)
        }
        if let cursor {
          Button("Load more") { Task { await load(cursor: cursor) } }.disabled(busy)
        }
        Button("Add account") { store.connect(target: connector.target) }
          .foregroundStyle(.primary).disabled(busy)
      } header: {
        Text("This chat")
      } footer: {
        Text("Choose the current account and which accounts this chat can use.")
      }
      Section {
        if let slug = connector.target.connectorSlug, store.canConfigurePermissions(slug: slug) {
          Button {
            permissionDestination = store.openPermissions(slug: slug, label: connector.label)
          } label: {
            HStack {
              OkouRowLabel("Permissions", okouSymbol: "sliders-horizontal")
              Spacer(minLength: OkouSpace.sm)
              OkouIcon("chevron-right", size: OkouIconSize.inline)
                .foregroundStyle(OkouColor.mutedForeground)
                .accessibilityHidden(true)
            }
          }
        }
        NavigationLink {
          ComposerConnectorDefaults(store: store, connector: connector)
        } label: {
          Label {
            Text("Manage accounts").foregroundStyle(.primary)
          } icon: {
            Image(systemName: "person.2").foregroundStyle(.secondary)
          }
        }
      }
    }
    .overlay {
      if loading && accounts.isEmpty && error == nil {
        ChatSettingsLoadingView(title: "Loading accounts…")
      }
    }
    .navigationTitle(connector.label)
    .navigationBarTitleDisplayMode(.inline)
    .connectorPermissionDestination(store: store, destination: $permissionDestination)
    .searchable(text: $search, prompt: "Find accounts")
    .task(id: search) { await load() }
    .refreshable {
      await store.refresh()
      await load()
    }
    .onChange(of: store.authorization.active?.id) { _, flowID in
      if flowID == nil { Task { await load() } }
    }
  }

  @ViewBuilder
  private func accountRow(_ account: ChatConnectorAccount, access: ChatConnectorAccess.Account)
    -> some View
  {
    HStack(spacing: 12) {
      Button {
        Task { await store.selectAccount(target: connector.target, connectionID: account.id) }
      } label: {
        HStack(spacing: 10) {
          Image(
            systemName: current?.access?.currentConnectionId == account.id
              ? "checkmark.circle.fill" : "circle"
          ).accessibilityHidden(true)
          VStack(alignment: .leading, spacing: 3) {
            Text(account.label).foregroundStyle(.primary).lineLimit(1)
            if !account.ready {
              Text("Reconnect required").font(.caption).foregroundStyle(.secondary)
            }
          }
          Spacer(minLength: 0)
        }.frame(minHeight: 44).contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(busy || !access.enabled || !account.ready)
      .accessibilityLabel("Use \(account.label)")
      .accessibilityValue(current?.access?.currentConnectionId == account.id ? "Selected" : "")
      Picker(
        "Access for \(account.label)",
        selection: Binding(
          get: { ConnectorAccountChoice(access.overrideEnabled) },
          set: { choice in
            Task {
              await store.setAccountAccess(
                target: connector.target, connectionID: account.id, enabled: choice.enabled)
            }
          })
      ) {
        Text(access.defaultEnabled ? "Default (On)" : "Default (Off)")
          .tag(ConnectorAccountChoice.inherited)
        Text("On").tag(ConnectorAccountChoice.on)
        Text("Off").tag(ConnectorAccountChoice.off)
      }
      .pickerStyle(.menu).labelsHidden().fixedSize(horizontal: true, vertical: false)
      .disabled(busy)
    }
    if !account.ready {
      Button("Reconnect this account") {
        store.connect(target: connector.target, accountID: account.id)
      }.font(.footnote).disabled(busy)
    }
  }

  private func load(cursor: String? = nil) async {
    let request = UUID()
    requestID = request
    loading = true
    defer { if requestID == request { loading = false } }
    do {
      let result = try await store.service.accounts(
        target: connector.target, search: search, cursor: cursor)
      guard !Task.isCancelled, requestID == request else { return }
      accounts = cursor == nil ? result.connections : accounts + result.connections
      self.cursor = result.nextCursor
      error = nil
    } catch is CancellationError {
    } catch {
      guard requestID == request else { return }
      self.error = ChatRequestFailure.message(for: error)
    }
  }
}

private struct ComposerConnectorDefaults: View {
  let store: ComposerConnectorStore
  let connector: ChatComposerConnector
  @State private var accounts: [ChatConnectorAccount] = []
  @State private var defaults: [ChatConnectorAccountDefault] = []
  @State private var search = ""
  @State private var cursor: String?
  @State private var loading = false
  @State private var error: String?
  @State private var requestID = UUID()
  private var busy: Bool { loading || store.isSaving || store.uncertain }

  var body: some View {
    List {
      if let error = error ?? store.error ?? store.connectorError {
        ConnectorLoadError(error: error, isLoading: loading || store.isLoading) {
          await store.refresh()
          await load()
        }
      }
      Section {
        ForEach(accounts) { account in
          if let choice = defaults.first(where: { $0.connectionId == account.id }) {
            HStack(spacing: 12) {
              Button {
                Task {
                  await store.perform {
                    try await store.service.setDefaultAccount(
                      target: connector.target, connectionID: account.id)
                  }
                  await load()
                }
              } label: {
                HStack(spacing: 10) {
                  Image(systemName: choice.isDefault ? "checkmark.circle.fill" : "circle")
                    .accessibilityHidden(true)
                  VStack(alignment: .leading, spacing: 3) {
                    Text(account.label).foregroundStyle(.primary).lineLimit(1)
                    if choice.isDefault {
                      Text("Default").font(.caption).foregroundStyle(.secondary)
                    }
                  }
                  Spacer(minLength: 0)
                }.frame(minHeight: 44).contentShape(Rectangle())
              }
              .buttonStyle(.plain).disabled(busy || !choice.defaultEnabled)
              .accessibilityLabel("Use \(account.label) as default")
              .accessibilityValue(choice.isDefault ? "Selected" : "")
              Toggle(
                "Enable \(account.label) by default",
                isOn: Binding(
                  get: { choice.defaultEnabled },
                  set: { enabled in
                    Task {
                      await store.perform {
                        try await store.service.setDefaultEnabled(
                          target: connector.target, connectionID: account.id, enabled: enabled)
                      }
                      await load()
                    }
                  })
              ).labelsHidden().disabled(busy)
            }
          }
        }
        if let cursor {
          Button("Load more") { Task { await load(cursor: cursor) } }.disabled(busy)
        }
        Button("Add account") { store.connect(target: connector.target) }
          .foregroundStyle(.primary).disabled(busy)
      } header: {
        Text("Saved accounts")
      } footer: {
        Text(
          "Enabled accounts are available to chats by default. Choose one enabled default account.")
      }
    }
    .overlay {
      if loading && accounts.isEmpty && error == nil {
        ChatSettingsLoadingView(title: "Loading accounts…")
      }
    }
    .navigationTitle("Manage accounts")
    .navigationBarTitleDisplayMode(.inline)
    .searchable(text: $search, prompt: "Find accounts")
    .task(id: search) { await load() }
    .refreshable {
      await store.refresh()
      await load()
    }
    .onChange(of: store.authorization.active?.id) { _, flowID in
      if flowID == nil { Task { await load() } }
    }
  }

  private func load(cursor: String? = nil) async {
    let request = UUID()
    requestID = request
    loading = true
    defer { if requestID == request { loading = false } }
    do {
      async let page = store.service.accounts(
        target: connector.target, search: search, cursor: cursor)
      async let settingsRequest = store.service.accountDefaults(target: connector.target)
      let (result, settings) = try await (page, settingsRequest)
      guard !Task.isCancelled, requestID == request else { return }
      accounts = cursor == nil ? result.connections : accounts + result.connections
      defaults = settings
      self.cursor = result.nextCursor
      error = nil
    } catch is CancellationError {
    } catch {
      guard requestID == request else { return }
      self.error = ChatRequestFailure.message(for: error)
    }
  }
}
