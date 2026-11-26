import ChatData
import SwiftUI

struct ComposerChatConnectorAccounts: View {
  let store: ComposerConnectorStore
  let resources: ComposerConnectorAccountResources
  let page: ComposerConnectorAccountResources.Page
  let busy: Bool
  let search: String
  /// From the snapshot the account page resolves.
  let canConfigurePermissions: Bool
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
      if page.policies == nil {
        Text("This chat").okouSectionHeader()
      }
    } footer: {
      if page.policies == nil {
        Text("Only affects this chat.").okouSectionNote()
      }
    }
    Section {
      if canConfigurePermissions {
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
      if let policies = page.policies {
        if let policy = policies.first(where: { $0.connectionId == account.id }) {
          ConnectorAccountPolicyMenu(account: account, policy: policy, resources: resources)
            .disabled(busy)
        }
      } else {
        Toggle(
          "Use \(account.label) in this chat",
          isOn: Binding(
            get: { access.enabled },
            set: { enabled in Task { await resources.apply(.access(account.id, enabled)) } })
        ).labelsHidden().disabled(busy).tint(OkouColor.primary400)
      }
    }
  }
}

struct ConnectorAccountPolicyMenu: View {
  let account: ChatConnectorAccount
  let policy: ChatConnectorAccountPolicy
  let resources: ComposerConnectorAccountResources

  private var status: LocalizedStringKey { policy.enabled ? "Allow" : "Deny" }

  private func update(_ choice: ChatConnectorAccountPolicyChoice) {
    Task { await resources.apply(.policy(account.id, choice)) }
  }

  private var duration: LocalizedStringKey? {
    guard let expiresAt = policy.expiresAt else { return policy.enabled ? "Always" : nil }
    guard policy.enabled else { return "Expired" }
    let hours = expiresAt.timeIntervalSinceNow / 3_600
    let roundedHours = Int(hours.rounded())
    if roundedHours < 1 { return "<1h" }
    if roundedHours > 24 { return "\(Int((hours / 24).rounded()))d" }
    return "\(roundedHours)h"
  }

  var body: some View {
    Menu {
      Button("Allow always") { update(.allowAlways) }
      Button("Allow for 1h") { update(.allowHour) }
      Button("Allow for 24h") { update(.allowDay) }
      Button("Allow for 7d") { update(.allowWeek) }
      Divider()
      Button("Deny") { update(.deny) }
    } label: {
      HStack(spacing: OkouSpace.xs) {
        Text(status)
        if let duration {
          Text(duration).font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
        }
        OkouIcon("chevron-down", size: OkouIconSize.inline).accessibilityHidden(true)
      }
      .frame(minHeight: OkouControl.minimumTarget)
    }
    .accessibilityLabel("Access for \(account.label)")
    .accessibilityValue(duration.map { Text("\(Text(status)) \(Text($0))") } ?? Text(status))
  }
}
