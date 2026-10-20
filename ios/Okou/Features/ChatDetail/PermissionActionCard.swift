import ChatData
import SwiftUI

struct PermissionActionCard: View {
  @Bindable var store: PermissionActionStore
  let loadsState: Bool
  @ScaledMetric(relativeTo: .body) private var height: CGFloat = 220
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
    if store.error != nil { return String(localized: "Unable to complete. Open details to retry.") }
    if store.snapshot != nil && !store.hasPermission {
      return String(localized: "Permission unavailable")
    }
    if store.needsContinuation {
      return String(localized: "Permission saved. Continue the conversation.")
    }
    if store.applied {
      if let expiry = store.grant?.expiresAt, expiry > .now {
        return String(
          localized: "Expires \(expiry.formatted(date: .abbreviated, time: .shortened))")
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
    VStack(alignment: .leading, spacing: 8) {
      Label(store.metadata?.label ?? store.action.connectorSlug, systemImage: "lock.shield")
        .font(.headline).lineLimit(1)
      Group {
        if store.action.action == .allow {
          Text("Allow \(permission)")
        } else {
          Text("Deny \(permission)")
        }
      }
      .font(.subheadline).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
      Text("Your permissions for \(store.snapshot?.agentName ?? String(localized: "this Agent"))")
        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
      Text(status).font(.caption).foregroundStyle(store.error == nil ? Color.secondary : Color.red)
        .lineLimit(2).frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
      Spacer(minLength: 0)
      Button("Review permission") { showsDetails = true }
        .buttonStyle(.bordered)
        .accessibilityIdentifier("permission-review")
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .frame(height: height, alignment: .topLeading)
    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
    .accessibilityIdentifier("permission-action-card")
    .sheet(isPresented: $showsDetails) { PermissionActionDetails(store: store) }
    .task { if loadsState { await store.refresh() } }
    .task(id: store.grant?.expiresAt) {
      guard loadsState, let expiry = store.grant?.expiresAt, expiry > .now else { return }
      try? await Task.sleep(for: .seconds(expiry.timeIntervalSinceNow))
      guard !Task.isCancelled else { return }
      await store.refresh()
    }
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
            .font(.caption).foregroundStyle(.secondary)
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
            Text("\(method) \(path)").font(.caption.monospaced()).textSelection(.enabled)
          }
          if let reason = store.action.reason, !reason.isEmpty {
            Text(reason).textSelection(.enabled)
          }
        }
        Section {
          if store.isLoading || (store.snapshot == nil && store.error == nil) {
            ProgressView("Checking permission…")
          }
          if let error = store.error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
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
              .disabled(store.isSaving || store.isLoading)
              .accessibilityIdentifier("permission-duration")
            }
            if store.action.callbackPrompt != nil {
              Text("The conversation will continue after confirmation.").font(.caption)
            }
            Button {
              Task { await store.confirm() }
            } label: {
              if store.needsContinuation {
                Text("Continue conversation")
              } else if store.action.action == .allow {
                Text("Allow permission")
              } else {
                Text("Deny permission")
              }
            }
            .disabled(!store.canConfirm)
            .accessibilityIdentifier("permission-confirm")
          }
          if store.isSaving { ProgressView("Saving permission…") }
        }
      }
      .navigationTitle("Permission request")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
      }
    }
  }
}
