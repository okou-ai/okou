import ChatData
import SwiftUI

struct PermissionActionCard: View {
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
        systemImage: "lock.shield", titleLineLimit: 1
      ) {
        if store.action.action == .allow {
          Text("Allow \(permission)")
        } else {
          Text("Deny \(permission)")
        }
        Text(
          "For \(store.snapshot?.agentName ?? String(localized: "this Agent")) · \(status)"
        )
        .font(.caption)
        .lineLimit(1, reservesSpace: true)
        .foregroundStyle(.secondary)
      }
    } actions: {
      if store.applied && !store.needsContinuation && store.error == nil && !store.isLoading
        && !store.isSaving
      {
        HStack(spacing: 8) {
          Label(
            store.action.action == .allow
              ? String(localized: "Allowed") : String(localized: "Denied"),
            systemImage: store.action.action == .allow ? "checkmark.circle" : "minus.circle"
          )
          .font(.subheadline)
          .foregroundStyle(store.action.action == .allow ? Color.green : Color.secondary)
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
  @Bindable var store: PermissionActionStore
  @Environment(\.dismiss) private var dismiss
  @State private var confirmingContinuation = false

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          if store.snapshot != nil || store.error != nil {
            requestSummary
            confirmation
          }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .background(Color(uiColor: .systemGroupedBackground))
      .overlay {
        if store.snapshot == nil && store.error == nil {
          ChatSettingsLoadingView(title: "Checking permission…")
        }
      }
      .navigationTitle("Permission request")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
      }
    }
  }

  private var requestSummary: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack(spacing: 12) {
        Image(systemName: "lock.shield")
          .font(.title3).foregroundStyle(.secondary)
          .frame(width: 40, height: 40)
          .background(Color(uiColor: .tertiarySystemGroupedBackground), in: .rect(cornerRadius: 12))
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 4) {
          Text(store.metadata?.label ?? store.action.connectorSlug).font(.headline)
          Text("Requested by \(store.snapshot?.agentName ?? String(localized: "this Agent"))")
            .font(.subheadline).foregroundStyle(.secondary)
        }
      }
      Divider()
      VStack(alignment: .leading, spacing: 8) {
        Text(
          store.action.permission == "__unknown__"
            ? String(localized: "Other endpoints") : store.action.permission
        )
        .font(.subheadline.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
        if let description = store.metadata?.permissions.first(where: {
          $0.name == store.action.permission
        })?.description {
          Text(description).textSelection(.enabled)
        }
        Text("These permissions apply to your account for this Agent.")
          .font(.footnote).foregroundStyle(.secondary)
      }
      if let method = store.action.method, let path = store.action.path {
        Text("\(method) \(path)").font(.caption.monospaced()).textSelection(.enabled)
      }
      if let reason = store.action.reason, !reason.isEmpty {
        Text(reason).font(.subheadline).textSelection(.enabled)
      }
    }
    .padding(18)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color(uiColor: .secondarySystemGroupedBackground), in: .rect(cornerRadius: 20))
  }

  @ViewBuilder private var confirmation: some View {
    if let error = store.error {
      Text(error).foregroundStyle(.red).textSelection(.enabled)
    }
    if store.snapshot == nil && store.error != nil && !store.isLoading {
      Button("Retry loading") { Task { await store.refresh() } }
        .frame(minHeight: 44)
    } else if store.snapshot != nil && !store.hasPermission && !store.isLoading {
      Text("This permission is no longer available.")
    }
    if store.applied && !store.isSaving {
      VStack(alignment: .leading, spacing: 4) {
        Label(
          store.action.action == .allow
            ? String(localized: "Allowed") : String(localized: "Denied"),
          systemImage: "checkmark.circle")
        if let expiry = store.grant?.expiresAt, expiry > .now {
          Text("Expires \(expiry.formatted(date: .abbreviated, time: .shortened))")
            .font(.footnote).foregroundStyle(.secondary)
        } else if store.action.action == .allow {
          Text("No expiration").font(.footnote).foregroundStyle(.secondary)
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
          .pickerStyle(.menu).labelsHidden()
          .disabled(store.isSaving || store.isLoading)
          .accessibilityIdentifier("permission-duration")
        }
        .frame(minHeight: 44)
        .padding(.horizontal, 16).padding(.vertical, 4)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: .rect(cornerRadius: 20))
      }
      VStack(spacing: 10) {
        Button {
          confirmingContinuation = store.needsContinuation
          Task { await store.confirm() }
        } label: {
          ChatSettingsActionLabel(title: confirmationTitle, isBusy: store.isSaving)
        }
        .buttonStyle(.borderedProminent).controlSize(.large)
        .buttonBorderShape(.roundedRectangle(radius: 12))
        .tint(Color("AccentColor"))
        .disabled(!store.canConfirm)
        .accessibilityIdentifier("permission-confirm")
        if store.action.callbackPrompt != nil {
          Text("The chat will continue after confirmation.")
            .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
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
