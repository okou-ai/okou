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
        icon: "shield-check", titleLineLimit: 1
      ) {
        if store.action.action == .allow {
          Text("Allow \(permission)")
        } else {
          Text("Deny \(permission)")
        }
        Text(
          "For \(store.snapshot?.agentName ?? String(localized: "this Agent")) · \(status)"
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
  @Bindable var store: PermissionActionStore
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      Form {
        Section {
          LabeledContent("Connector", value: store.metadata?.label ?? store.action.connectorSlug)
          LabeledContent(
            "Agent", value: store.snapshot?.agentName ?? store.action.agentID)
          Text("These permissions apply to your account for this Agent.")
            .font(.okou(.caption)).foregroundStyle(OkouColor.mutedForeground)
          LabeledContent(
            "Permission",
            value: store.action.permission == "__unknown__"
              ? String(localized: "Other endpoints") : store.action.permission)
          if let description = store.metadata?.permissions.first(where: {
            $0.name == store.action.permission
          })?.description {
            Text(description).textSelection(.enabled)
          }
          if let method = store.action.method, let path = store.action.path {
            Text("\(method) \(path)").font(.okou(.caption).monospaced()).textSelection(.enabled)
          }
          if let reason = store.action.reason, !reason.isEmpty {
            Text(reason).textSelection(.enabled)
          }
        }
        Section {
          if store.isLoading || (store.snapshot == nil && store.error == nil) {
            OkouLoadingRow("Checking permission…")
          }
          if let error = store.error {
            OkouLoadErrorRow(message: error)
          }
          if store.snapshot == nil && store.error != nil && !store.isLoading {
            Button("Retry loading") { Task { await store.refresh() } }
          } else if store.snapshot != nil && !store.hasPermission && !store.isLoading {
            Text("This permission is no longer available.")
          }
          if store.applied {
            Text(
              store.action.action == .allow
                ? String(localized: "Allowed") : String(localized: "Denied"))
            if let expiry = store.grant?.expiresAt, expiry > .now {
              Text("Expires \(expiry.formatted(date: .abbreviated, time: .shortened))")
            } else if store.action.action == .allow {
              Text("No expiration")
            }
          }
          if store.hasPermission && (!store.applied || store.needsContinuation) {
            if store.action.action == .allow && !store.needsContinuation {
              Picker("Duration", selection: $store.duration) {
                Text("1 hour").tag(ChatPermissionAction.Duration.hour)
                Text("24 hours").tag(ChatPermissionAction.Duration.day)
                Text("7 days").tag(ChatPermissionAction.Duration.week)
                Text("Always").tag(ChatPermissionAction.Duration.always)
              }
              .okouValuePicker()
              .disabled(store.isSaving || store.isLoading)
              .accessibilityIdentifier("permission-duration")
            }
            if store.action.callbackPrompt != nil {
              Text("The chat will continue after confirmation.").font(.okou(.caption))
            }
            Button {
              Task { await store.confirm() }
            } label: {
              if store.needsContinuation {
                Text("Continue chat")
              } else if store.action.action == .allow {
                Text("Allow permission")
              } else {
                Text("Deny permission")
              }
            }
            .disabled(!store.canConfirm)
            .accessibilityIdentifier("permission-confirm")
          }
          if store.isSaving { OkouLoadingRow("Saving permission…") }
        }
      }
      .okouGroupedBackground()
      .navigationTitle("Permission request")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { OkouCloseToolbarItem { dismiss() } }
    }
  }
}
