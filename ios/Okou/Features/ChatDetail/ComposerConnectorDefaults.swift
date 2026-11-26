import CCState
import CCStateSwiftUI
import ChatData
import SwiftUI

struct ComposerConnectorDefaults: View {
  let store: ComposerConnectorStore
  let resources: ComposerConnectorAccountResources
  let page: ComposerConnectorAccountResources.Page
  let busy: Bool
  @ResolvedValue private var managesAccounts: Bool?
  @State private var renaming: ChatConnectorAccount?
  @State private var name = ""
  @State private var disconnecting: ChatConnectorAccount?

  init(
    store: ComposerConnectorStore, resources: ComposerConnectorAccountResources,
    page: ComposerConnectorAccountResources.Page, busy: Bool
  ) {
    self.store = store
    self.resources = resources
    self.page = page
    self.busy = busy
    _managesAccounts = ResolvedValue(store.managementValue)
  }

  private var isAuthorizing: Bool {
    store.authorization.isAuthorizing(target: resources.connector.target)
  }

  var body: some View {
    ForEach(page.accounts) { account in
      Section {
        HStack(spacing: OkouSpace.md) {
          VStack(alignment: .leading, spacing: OkouSpace.xs) {
            Text(account.label).foregroundStyle(OkouColor.foreground).lineLimit(1)
            if let identity = account.externalEmail ?? account.externalUsername,
              identity != account.label
            {
              Text(identity).font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
                .lineLimit(1)
            }
          }
          Spacer(minLength: 0)
          if managesAccounts ?? store.canManageAccounts {
            Menu {
              Button("Reconnect") {
                store.connect(target: resources.connector.target, accountID: account.id)
              }
              Button("Rename") {
                name = account.displayName ?? ""
                renaming = account
              }
              Button("Disconnect", role: .destructive) {
                resources.prepareDisconnect(account.id)
                disconnecting = account
              }
            } label: {
              OkouIcon("ellipsis", size: OkouIconSize.standard)
                .frame(minWidth: OkouControl.minimumTarget, minHeight: OkouControl.minimumTarget)
            }
            .accessibilityLabel("Actions for \(account.label)").disabled(busy)
          }
        }
        if !account.ready {
          HStack(spacing: OkouSpace.sm) {
            Label("Reconnect required", okouSymbol: "triangle-alert", iconSize: OkouIconSize.inline)
              .font(.okou(.footnote)).foregroundStyle(OkouStatusColor.warning).lineLimit(1)
            Spacer(minLength: 0)
            Button("Reconnect") {
              store.connect(target: resources.connector.target, accountID: account.id)
            }.disabled(busy)
          }
        }
        if let policies = page.policies {
          if let policy = policies.first(where: { $0.connectionId == account.id }) {
            ConnectorAccountPolicyMenu(account: account, policy: policy, resources: resources)
              .disabled(busy)
          }
        } else if let choice = page.defaults.first(where: { $0.connectionId == account.id }) {
          Toggle(
            "Use by default",
            isOn: Binding(
              get: { choice.defaultEnabled },
              set: { enabled in
                Task { await resources.apply(.defaultEnabled(account.id, enabled)) }
              })
          ).tint(OkouColor.primary400).disabled(busy)
        }
      }
    }
    Section {
      if page.nextCursor != nil {
        Button("Load more") { Task { await resources.loadMore() } }.disabled(busy)
      }
      Button {
        store.connect(target: resources.connector.target)
      } label: {
        Label {
          Text("Add account")
        } icon: {
          OkouIcon("plus")
            .opacity(isAuthorizing ? 0 : 1)
            .overlay {
              if isAuthorizing { ProgressView().controlSize(.small) }
            }
        }
      }
      .disabled(busy || store.authorization.active != nil)
      .accessibilityValue(isAuthorizing ? Text("Connecting…") : Text(""))
    } footer: {
      if page.policies == nil {
        Text("Used unless a chat chooses otherwise.").okouSectionNote()
      } else {
        Text("Applies across your chats.").okouSectionNote()
      }
    }
    .alert(
      "Rename account",
      isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })
    ) {
      TextField("Name", text: $name)
      Button("Cancel", role: .cancel) { renaming = nil }
      Button("Save") {
        guard let account = renaming else { return }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        Task { await resources.apply(.rename(account.id, trimmed.isEmpty ? nil : trimmed)) }
        renaming = nil
      }.disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).count > 255)
    }
    .sheet(
      item: $disconnecting, onDismiss: { resources.prepareDisconnect(nil) },
      content: { account in
        NavigationStack {
          ConnectorDisconnectConfirmation(store: store, resources: resources, account: account)
        }.presentationDetents([.medium]).okouSheetBackground()
      })
  }
}

private struct ConnectorDisconnectConfirmation: View {
  let store: ComposerConnectorStore
  let resources: ComposerConnectorAccountResources
  let account: ChatConnectorAccount
  @LoadableValue private var impact: Loadable<ChatConnectorDeletionImpact?>
  @Environment(\.dismiss) private var dismiss

  init(
    store: ComposerConnectorStore, resources: ComposerConnectorAccountResources,
    account: ChatConnectorAccount
  ) {
    self.store = store
    self.resources = resources
    self.account = account
    _impact = LoadableValue(task: resources.deletionImpact)
  }

  var body: some View {
    Form {
      Text(account.label).font(.okou(.body).weight(.medium))
      switch impact {
      case .loading: OkouLoadingRow("Checking affected chats…")
      case .hasError(let error):
        ConnectorLoadError(error: ChatRequestFailure.message(for: error)) {
          resources.prepareDisconnect(nil)
          resources.prepareDisconnect(account.id)
        }
      case .hasData(let value):
        if let value {
          Text("\(value.explicitSelectionCount) chats use this account.")
          Text("Disconnecting removes this saved account across the workspace.")
            .font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
          if let error = store.error { Text(error).foregroundStyle(OkouColor.destructive) }
          Button("Disconnect", role: .destructive) {
            Task {
              await resources.apply(.disconnect(account.id))
              if store.error == nil && !store.uncertain { dismiss() }
            }
          }.disabled(store.isSaving || store.isUpdatingAccounts || store.uncertain)
        }
      }
    }
    .okouGroupedBackground().navigationTitle("Disconnect account?")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar { OkouCloseToolbarItem { dismiss() } }
    .interactiveDismissDisabled(store.isSaving)
  }
}
