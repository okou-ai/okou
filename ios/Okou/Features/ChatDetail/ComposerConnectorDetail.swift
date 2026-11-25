import ChatData
import SwiftUI

struct ComposerConnectorDetail: View {
  let store: ComposerConnectorStore
  let connector: ChatCatalogConnector
  @State private var permissionDestination: ComposerConnectorPermissionResources?
  @State private var accountDestination: ComposerConnectorAccountResources?

  private var added: Bool {
    store.connectors.contains { $0.target.connectorSlug == connector.slug }
  }

  private var isAuthorizing: Bool {
    store.authorization.isAuthorizing(target: .builtin(connector.slug))
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: OkouSpace.lg) {
        hero
        if let current = store.connectors.first(where: { $0.target.connectorSlug == connector.slug }
        ) {
          management(current)
        }
        facts
        // One method is already named under "Sign in with"; several are worth explaining.
        if connector.authMethods.count > 1 {
          methods
        }
      }
      .padding(.horizontal, OkouSpace.lg)
      .padding(.bottom, OkouSpace.xxl)
    }
    .okouGroupedBackground(OkouColor.background)
    .navigationTitle("")
    .navigationBarTitleDisplayMode(.inline)
    .connectorPermissionDestination(store: store, destination: $permissionDestination)
    .connectorAccountDestination(store: store, destination: $accountDestination)
  }

  private func management(_ current: ChatComposerConnector) -> some View {
    VStack(spacing: 0) {
      if current.needsAttention {
        HStack(spacing: OkouSpace.sm) {
          Label("Reconnect required", okouSymbol: "triangle-alert", iconSize: OkouIconSize.inline)
            .font(.okou(.footnote)).foregroundStyle(OkouStatusColor.warning).lineLimit(1)
          Spacer(minLength: 0)
          Button("Reconnect") {
            if current.reconnectAccountIDs.count == 1, let id = current.reconnectAccountIDs.first {
              store.connect(target: current.target, accountID: id)
            } else {
              accountDestination = store.openAccounts(current, managesDefaults: true)
            }
          }.disabled(store.isSaving || store.uncertain)
        }.frame(minHeight: OkouControl.listRow)
        Divider()
      }
      Button {
        accountDestination = store.openAccounts(current, managesDefaults: true)
      } label: {
        HStack {
          OkouRowLabel("Manage accounts", okouSymbol: "users")
          Spacer(minLength: 0)
          Text("\(current.access.accounts.count)").foregroundStyle(OkouColor.mutedForeground)
          OkouIcon("chevron-right", size: OkouIconSize.inline)
            .foregroundStyle(OkouColor.mutedForeground)
        }.frame(minHeight: OkouControl.listRow)
      }.foregroundStyle(OkouColor.foreground)
    }.padding(.horizontal, OkouSpace.lg).modifier(OkouSurfaceStyle())
  }

  private var hero: some View {
    VStack(spacing: OkouSpace.md) {
      OkouLogoTile(size: OkouControl.logoTileLarge) {
        ConnectorLogo(icon: connector.icon, pointSize: OkouIconSize.partnerLogoLarge)
      }
      VStack(spacing: OkouSpace.xs) {
        Text(connector.label)
          .font(.okou(.title3).weight(.semibold))
          .foregroundStyle(OkouColor.foreground)
        Text(connector.description)
          .font(.okou(.subheadline))
          .foregroundStyle(OkouColor.mutedForeground)
          .multilineTextAlignment(.center)
          .textSelection(.enabled)
      }
      HStack(spacing: OkouSpace.sm) {
        Button {
          store.connect(connector)
        } label: {
          if added {
            OkouCompactButtonLabel("Add account", icon: "plus", isBusy: isAuthorizing)
          } else {
            OkouCompactButtonLabel("Connect", icon: "plug", isBusy: isAuthorizing)
          }
        }
        .buttonStyle(OkouButtonStyle(isPrimary: !added, isCompact: true))
        .disabled(store.authorization.active != nil)
        .accessibilityValue(isAuthorizing ? Text("Connecting…") : Text(""))
        .accessibilityIdentifier("connector-connect")
        if connector.permissionSummary.hasPermissions
          && store.canConfigurePermissions(slug: connector.slug)
        {
          Button {
            permissionDestination = store.openPermissions(
              slug: connector.slug, label: connector.label)
          } label: {
            OkouCompactButtonLabel("Permissions", icon: "shield-check")
          }
          .buttonStyle(OkouButtonStyle(isPrimary: false, isCompact: true))
        }
      }
      .padding(.top, OkouSpace.sm)
    }
    .frame(maxWidth: .infinity)
    .padding(OkouSpace.xl)
    .modifier(OkouSurfaceStyle())
  }

  private var facts: some View {
    VStack(spacing: 0) {
      factRow("Status") {
        HStack(spacing: OkouSpace.xs) {
          if added {
            OkouIcon("check", size: OkouIconSize.inline).foregroundStyle(OkouStatusColor.success)
            Text("Connected")
          } else {
            Text("Not connected")
          }
        }
      }
      Divider()
      factRow("Category") { Text(ConnectorCategoryName.full(connector.category)) }
      if !connector.authMethods.isEmpty {
        Divider()
        factRow("Sign in with") {
          Text(connector.authMethods.map(\.label).joined(separator: ", "))
        }
      }
    }
    .padding(.horizontal, OkouSpace.lg)
    .modifier(OkouSurfaceStyle())
  }

  private func factRow<Value: View>(_ label: LocalizedStringKey, @ViewBuilder value: () -> Value)
    -> some View
  {
    HStack(spacing: OkouSpace.md) {
      Text(label).foregroundStyle(OkouColor.mutedForeground)
      Spacer(minLength: 0)
      value().foregroundStyle(OkouColor.foreground).multilineTextAlignment(.trailing)
    }
    .font(.okou(.subheadline))
    .frame(minHeight: OkouControl.listRow)
  }

  private var methods: some View {
    VStack(alignment: .leading, spacing: OkouSpace.sm) {
      Text("Connection methods").okouSectionHeader()
      VStack(alignment: .leading, spacing: 0) {
        ForEach(Array(connector.authMethods.enumerated()), id: \.offset) { index, method in
          if index > 0 { Divider() }
          VStack(alignment: .leading, spacing: OkouSpace.two) {
            Text(method.label).font(.okou(.subheadline).weight(.medium))
            if let description = method.description, !description.isEmpty {
              Text(description)
                .font(.okou(.footnote))
                .foregroundStyle(OkouColor.mutedForeground)
            }
          }
          .padding(.vertical, OkouSpace.md)
          .frame(maxWidth: .infinity, alignment: .leading)
        }
      }
      .padding(.horizontal, OkouSpace.lg)
      .modifier(OkouSurfaceStyle())
    }
  }
}
