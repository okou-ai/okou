import ChatData
import SwiftUI

struct PermissionActionCard: View {
  @Environment(\.singleAgentExperience) private var singleAgent

  @Bindable var store: PermissionActionStore
  let loadsState: Bool
  @State private var showsDetails = false

  private var permission: String {
    store.action.permission == "__unknown__"
      ? String(localized: "Other endpoints") : store.action.permission
  }
  private var status: String {
    if store.isSaving { return String(localized: "Saving permission…") }
    if store.isLoading || (store.snapshot == nil && store.error == nil) {
      return String(localized: "Checking permission…")
    }
    if store.error != nil { return String(localized: "Open details to check permission") }
    if store.snapshot != nil && !store.hasPermission {
      return String(localized: "Permission unavailable")
    }
    if store.needsContinuation {
      return String(localized: "Permission saved · Continuation needed")
    }
    if store.applied {
      if let expiry = store.grant?.expiresAt, expiry > .now {
        let date = expiry.formatted(.dateTime.month(.abbreviated).day().hour().minute())
        return String(localized: "Expires \(date)")
      }
      return store.action.action == .allow
        ? String(localized: "Allowed · No expiration") : String(localized: "Denied")
    }
    if store.grant?.expiresAt.map({ $0 <= .now }) == true {
      return String(localized: "Previous permission expired")
    }
    return String(localized: "Waiting for your confirmation")
  }

  var body: some View {
    let connectorLabel = store.metadata?.label ?? store.action.connectorSlug
    ChatActionCard {
      ChatCardHeader(
        title: String(localized: "\(connectorLabel) permissions"),
        icon: "shield-check", titleLineLimit: 1
      ) {
        if store.action.action == .allow {
          Text("Allow \(permission)")
        } else {
          Text("Deny \(permission)")
        }
        Text(
          store.snapshot?.connectorScoped == true
            ? status
            : String(
              localized:
                "For \(singleAgent ? "Okou" : (store.snapshot?.agentName ?? String(localized: "this Agent"))) · \(status)"
            )
        )
        .lineLimit(1, reservesSpace: true)
      }
    } actions: {
      if store.applied && !store.needsContinuation && store.error == nil && !store.isLoading
        && !store.isSaving
      {
        HStack(spacing: OkouSpace.sm) {
          Label(
            store.action.action == .allow
              ? String(localized: "Allowed") : String(localized: "Denied"),
            okouSymbol: store.action.action == .allow ? "circle-check" : "circle-minus"
          )
          .font(.okou(.subheadline))
          .foregroundStyle(
            store.action.action == .allow ? OkouStatusColor.success : OkouColor.mutedForeground
          )
          .fixedSize(horizontal: false, vertical: true)
          Spacer(minLength: 0)
          Button("View details") { showsDetails = true }
            .buttonStyle(ChatCardButtonStyle(emphasis: .detail))
            .accessibilityIdentifier("permission-review")
        }
      } else {
        Button {
          showsDetails = true
        } label: {
          if store.needsContinuation {
            Text("Review continuation")
          } else if store.error != nil {
            Text("View details")
          } else {
            Text("Review permission")
          }
        }
        .accessibilityIdentifier("permission-review")
      }
    }
    .accessibilityIdentifier("permission-action-card")
    .sheet(isPresented: $showsDetails) { PermissionActionDetails(store: store) }
    .task(id: store.isActive) { if loadsState { await store.loadIfNeeded() } }
  }
}

struct PermissionActionDetails: View {
  @Environment(\.singleAgentExperience) private var singleAgent

  @Bindable var store: PermissionActionStore
  @Environment(\.dismiss) private var dismiss
  @State private var confirmingContinuation = false

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: OkouSpace.lg) {
          if store.snapshot != nil || store.error != nil {
            requestSummary
            confirmation
          }
        }
        .padding(OkouSpace.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .overlay {
        if store.snapshot == nil && store.error == nil {
          ChatSettingsLoadingView(title: "Checking permission…")
        }
      }
      .okouGroupedBackground()
      .navigationTitle("Permission request")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { OkouCloseToolbarItem { dismiss() } }
    }
  }

  private var requestSummary: some View {
    VStack(alignment: .leading, spacing: OkouSpace.lg) {
      HStack(spacing: OkouSpace.md) {
        OkouLogoTile(size: OkouControl.logoTile) {
          OkouIcon("shield-check", size: OkouIconSize.standard)
            .foregroundStyle(OkouColor.mutedForeground)
        }
        VStack(alignment: .leading, spacing: OkouSpace.xs) {
          Text(store.metadata?.label ?? store.action.connectorSlug)
            .font(.okou(.headline)).foregroundStyle(OkouColor.foreground)
          Text(
            "Requested by \(singleAgent ? "Okou" : (store.snapshot?.agentName ?? String(localized: "this Agent")))"
          )
          .font(.okou(.subheadline)).foregroundStyle(OkouColor.mutedForeground)
        }
      }
      Divider()
      VStack(alignment: .leading, spacing: OkouSpace.sm) {
        Text(
          store.action.permission == "__unknown__"
            ? String(localized: "Other endpoints") : store.action.permission
        )
        .font(.okou(.subheadline, design: .monospaced)).foregroundStyle(OkouColor.mutedForeground)
        .textSelection(.enabled)
        if let description = store.metadata?.permissions.first(where: {
          $0.name == store.action.permission
        })?.description {
          Text(description).textSelection(.enabled)
        }
        Text(
          store.snapshot?.connectorScoped == true
            ? "These permissions apply to this connector across your chats and accounts."
            : (singleAgent
              ? "These permissions apply to your account for Okou across chats in this workspace."
              : "These permissions apply to your account for this Agent.")
        )
        .okouSectionNote()
      }
      if let method = store.action.method, let path = store.action.path {
        Text("\(method) \(path)").font(.okou(.caption, design: .monospaced)).textSelection(.enabled)
      }
      if let reason = store.action.reason, !reason.isEmpty {
        Text(reason).font(.okou(.subheadline)).textSelection(.enabled)
      }
    }
    .padding(OkouSpace.lg)
    .frame(maxWidth: .infinity, alignment: .leading)
    .modifier(OkouSurfaceStyle())
  }

  @ViewBuilder private var confirmation: some View {
    if let error = store.error {
      // A failed read is quiet, with its retry beside it.
      if store.snapshot == nil && !store.isLoading {
        OkouLoadErrorRow(message: error, actionTitle: "Retry loading") { await store.refresh() }
      } else {
        OkouLoadErrorRow(message: error)
      }
    }
    if store.snapshot != nil && !store.hasPermission && !store.isLoading {
      Text("This permission is no longer available.")
    }
    if store.applied && !store.isSaving {
      VStack(alignment: .leading, spacing: OkouSpace.xs) {
        Label(
          store.action.action == .allow
            ? String(localized: "Allowed") : String(localized: "Denied"),
          okouSymbol: "circle-check")
        if let expiry = store.grant?.expiresAt, expiry > .now {
          Text("Expires \(expiry.formatted(date: .abbreviated, time: .shortened))")
            .okouSectionNote()
        } else if store.action.action == .allow {
          Text("No expiration").okouSectionNote()
        }
      }
    }
    if store.hasPermission && (!store.applied || store.needsContinuation || store.isSaving) {
      if store.action.action == .allow
        && (store.isSaving ? !confirmingContinuation : !store.needsContinuation)
      {
        HStack {
          Text("Allow for")
          Spacer()
          Picker("Allow for", selection: $store.duration) {
            Text("1 hour").tag(ChatPermissionAction.Duration.hour)
            Text("24 hours").tag(ChatPermissionAction.Duration.day)
            Text("7 days").tag(ChatPermissionAction.Duration.week)
            Text("Always").tag(ChatPermissionAction.Duration.always)
          }
          .okouValuePicker().labelsHidden()
          .disabled(store.isSaving || store.isLoading)
          .accessibilityIdentifier("permission-duration")
        }
        .font(.okou(.body))
        .frame(minHeight: OkouControl.listRow)
        .padding(.horizontal, OkouSpace.lg)
        .modifier(OkouSurfaceStyle())
      }
      VStack(spacing: OkouSpace.ten) {
        Button {
          confirmingContinuation = store.needsContinuation
          Task { await store.confirm() }
        } label: {
          ChatSettingsActionLabel(title: confirmationTitle, isBusy: store.isSaving)
        }
        .buttonStyle(OkouButtonStyle(isPrimary: true))
        .disabled(!store.canConfirm)
        .accessibilityIdentifier("permission-confirm")
        if store.action.callbackPrompt != nil {
          Text("The chat will continue after confirmation.")
            .okouSectionNote().multilineTextAlignment(.center)
        }
      }
    }
  }

  private var confirmationTitle: LocalizedStringKey {
    if store.isSaving {
      return confirmingContinuation ? "Continuing chat…" : "Saving permission…"
    }
    if store.needsContinuation { return "Continue chat" }
    return store.action.action == .allow ? "Allow permission" : "Deny permission"
  }
}
