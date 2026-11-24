import ChatData
import SwiftUI

struct ComposerChatConnectorAccounts: View {
  let store: ComposerConnectorStore
  let resources: ComposerConnectorAccountResources
  let page: ComposerConnectorAccountResources.Page
  let busy: Bool
  let search: String
  let openPermissions: () -> Void
  let openManagement: () -> Void

  var body: some View {
    Section {
      ForEach(page.accounts) { account in
        if let access = page.access.accounts.first(where: { $0.connectionId == account.id }) {
          accountRow(account, access: access)
        }
      }
      if page.accounts.isEmpty {
        Text(search.isEmpty ? "No saved accounts" : "No accounts found").foregroundStyle(
          OkouColor.mutedForeground)
      }
      if page.nextCursor != nil {
        Button("Load more") { Task { await resources.loadMore() } }.disabled(busy)
      }
    } header: {
      Text("This chat").okouSectionHeader()
    } footer: {
      Text("Only affects this chat.").okouSectionNote()
    }
    Section {
      if let slug = resources.connector.target.connectorSlug,
        store.canConfigurePermissions(slug: slug)
      {
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

  @ViewBuilder
  private func accountRow(_ account: ChatConnectorAccount, access: ChatConnectorAccess.Account)
    -> some View
  {
    HStack(spacing: OkouSpace.md) {
      VStack(alignment: .leading, spacing: OkouSpace.three) {
        Text(account.label).foregroundStyle(OkouColor.foreground).lineLimit(1)
        if let identity = account.externalEmail ?? account.externalUsername,
          identity != account.label
        {
          Text(identity).font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
            .lineLimit(1)
        }
        if !account.ready {
          Text("Reconnect required").font(.okou(.caption))
            .foregroundStyle(OkouColor.mutedForeground)
        }
      }
      .frame(minHeight: OkouControl.minimumTarget, alignment: .leading)
      Spacer(minLength: 0)
      Toggle(
        "Use \(account.label) in this chat",
        isOn: Binding(
          get: { access.enabled },
          set: { enabled in Task { await resources.apply(.access(account.id, enabled)) } })
      ).labelsHidden().disabled(busy).tint(OkouColor.primary400)

    }

  }
}
