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
  let resources: ComposerConnectorAccountResources
  let page: ComposerConnectorAccountResources.Page
  let busy: Bool
  let openPermissions: () -> Void
  let openManagement: () -> Void

  var body: some View {
    Section {
      ForEach(page.accounts) { account in
        if let access = page.access?.accounts.first(where: { $0.connectionId == account.id }) {
          accountRow(account, access: access)
        }
      }
      if page.accounts.isEmpty {
        Text("No accounts found").foregroundStyle(OkouColor.mutedForeground)
      }
      if page.nextCursor != nil {
        Button("Load more") { Task { await resources.loadMore() } }.disabled(busy)
      }
      Button("Add account") { store.connect(target: resources.connector.target) }
        .foregroundStyle(OkouColor.foreground).disabled(busy)
    } header: {
      Text("This chat").okouSectionHeader()
    } footer: {
      Text("Choose the current account and which accounts this chat can use.").okouSectionNote()
    }
    Section {
      if let slug = resources.connector.target.connectorSlug, store.canConfigurePermissions(slug: slug) {
        Button(action: openPermissions) {
          destinationLabel("Permissions", icon: "sliders-horizontal")
        }
      }
      Button(action: openManagement) {
        destinationLabel("Manage accounts", icon: "users")
      }
    }
  }

  private func destinationLabel(_ title: LocalizedStringKey, icon: String) -> some View {
    HStack {
      OkouRowLabel(title, okouSymbol: icon)
      Spacer(minLength: OkouSpace.sm)
      OkouIcon("chevron-right", size: OkouIconSize.inline)
        .foregroundStyle(OkouColor.mutedForeground).accessibilityHidden(true)
    }
  }

  private func accountRow(_ account: ChatConnectorAccount, access: ChatConnectorAccess.Account)
    -> some View
  {
    HStack(spacing: OkouSpace.md) {
      Button { Task { await resources.apply(.select(account.id)) } } label: {
        HStack(spacing: OkouSpace.sm) {
          OkouIcon(page.selectedID == account.id ? "circle-check" : "circle")
            .accessibilityHidden(true)
          VStack(alignment: .leading, spacing: OkouSpace.three) {
            Text(account.label).foregroundStyle(OkouColor.foreground).lineLimit(1)
            if !account.ready {
              Text("Reconnect required").font(.okou(.caption))
                .foregroundStyle(OkouColor.mutedForeground)
            }
          }
          Spacer(minLength: 0)
        }.frame(minHeight: OkouControl.minimumTarget).contentShape(Rectangle())
      }
      .buttonStyle(.plain).disabled(busy || !access.enabled || !account.ready)
      .accessibilityLabel("Use \(account.label)")
      .accessibilityValue(page.selectedID == account.id ? "Selected" : "")
      Picker(
        "Access for \(account.label)",
        selection: Binding(
          get: { ConnectorAccountChoice(access.overrideEnabled) },
          set: { choice in
            Task { await resources.apply(.access(account.id, choice.enabled)) }
          })
      ) {
        Text(access.defaultEnabled ? "Default (On)" : "Default (Off)")
          .tag(ConnectorAccountChoice.inherited)
        Text("On").tag(ConnectorAccountChoice.on)
        Text("Off").tag(ConnectorAccountChoice.off)
      }
      .pickerStyle(.menu).labelsHidden().fixedSize(horizontal: true, vertical: false).disabled(busy)
    }
    if !account.ready {
      Button("Reconnect this account") {
        store.connect(target: resources.connector.target, accountID: account.id)
      }.font(.okou(.footnote)).disabled(busy)
    }
  }
}

struct ComposerConnectorDefaults: View {
  let store: ComposerConnectorStore
  let resources: ComposerConnectorAccountResources
  let page: ComposerConnectorAccountResources.Page
  let busy: Bool

  var body: some View {
    Section {
      ForEach(page.accounts) { account in
        if let choice = page.defaults.first(where: { $0.connectionId == account.id }) {
          HStack(spacing: OkouSpace.md) {
            Button { Task { await resources.apply(.defaultAccount(account.id)) } } label: {
              HStack(spacing: OkouSpace.sm) {
                OkouIcon(choice.isDefault ? "circle-check" : "circle").accessibilityHidden(true)
                VStack(alignment: .leading, spacing: OkouSpace.three) {
                  Text(account.label).foregroundStyle(OkouColor.foreground).lineLimit(1)
                  if choice.isDefault {
                    Text("Default").font(.okou(.caption)).foregroundStyle(OkouColor.mutedForeground)
                  }
                }
                Spacer(minLength: 0)
              }.frame(minHeight: OkouControl.minimumTarget).contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(busy || !choice.defaultEnabled)
            .accessibilityLabel("Use \(account.label) as default")
            .accessibilityValue(choice.isDefault ? "Selected" : "")
            Toggle(
              "Enable \(account.label) by default",
              isOn: Binding(
                get: { choice.defaultEnabled },
                set: { enabled in
                  Task { await resources.apply(.defaultEnabled(account.id, enabled)) }
                })
            ).labelsHidden().disabled(busy).tint(OkouColor.primary400)
          }
        }
      }
      if page.nextCursor != nil {
        Button("Load more") { Task { await resources.loadMore() } }.disabled(busy)
      }
      Button("Add account") { store.connect(target: resources.connector.target) }
        .foregroundStyle(OkouColor.foreground).disabled(busy)
    } header: {
      Text("Saved accounts").okouSectionHeader()
    } footer: {
      Text("Enabled accounts are available to chats by default. Choose one enabled default account.")
        .okouSectionNote()
    }
  }
}
