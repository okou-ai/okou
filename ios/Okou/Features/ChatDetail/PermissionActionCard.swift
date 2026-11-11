import CCStateSwiftUI
import ChatData
import SwiftUI

struct PermissionActionCard: View {
  let store: PermissionActionStore
  let loadsState: Bool
  private let read: PermissionCardRead<ChatPermissionSnapshot>

  init(store: PermissionActionStore, loadsState: Bool) {
    self.store = store
    self.loadsState = loadsState
    read = store.read
  }

  var body: some View {
    PermissionCardReadView(read: read) { phase in
      PermissionActionCardContent(store: store, phase: phase)
    }
    .task(id: store.isActive) { if loadsState { await store.loadIfNeeded() } }
  }
}

private struct PermissionActionCardContent: View {
  @Bindable var store: PermissionActionStore
  let phase: Loadable<ChatPermissionSnapshot>
  @State private var showsDetails = false

  private var isLoading: Bool { phase.state == .loading }
  private var snapshot: ChatPermissionSnapshot? {
    phase.data ?? (isLoading ? store.snapshot : nil)
  }
  private var review: PermissionActionReview {
    PermissionActionReview(action: store.action, snapshot: snapshot)
  }
  private var needsContinuation: Bool { store.needsContinuation && review.applied }
  private var error: String? {
    phase.error.map(ChatRequestFailure.message(for:)) ?? store.error
  }

  private var permission: String {
    store.action.permission == "__unknown__"
      ? String(localized: "Other endpoints") : store.action.permission
  }
  private var status: String {
    if store.isSaving { return String(localized: "Saving permission…") }
    if isLoading || (snapshot == nil && error == nil) {
      return String(localized: "Checking permission…")
    }
    if error != nil { return String(localized: "Open details to check permission") }
    if snapshot != nil && !review.hasPermission {
      return String(localized: "Permission unavailable")
    }
    if needsContinuation {
      return String(localized: "Permission saved · Continuation needed")
    }
    if review.applied {
      if let expiry = review.grant?.expiresAt, expiry > .now {
        let date = expiry.formatted(.dateTime.month(.abbreviated).day().hour().minute())
        return String(localized: "Expires \(date)")
      }
      return store.action.action == .allow
        ? String(localized: "Allowed · No expiration") : String(localized: "Denied")
    }
    if review.grant?.expiresAt.map({ $0 <= .now }) == true {
      return String(localized: "Previous permission expired")
    }
    return String(localized: "Waiting for your confirmation")
  }

  var body: some View {
    let connectorLabel = review.metadata?.label ?? store.action.connectorSlug
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
          snapshot?.connectorScoped == true
            ? status
            : String(
              localized:
                "For \(snapshot?.agentName ?? String(localized: "this Agent")) · \(status)")
        )
        .lineLimit(1, reservesSpace: true)
      }
    } actions: {
      if review.applied && !needsContinuation && error == nil && !isLoading
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
          if needsContinuation {
            Text("Review continuation")
          } else if error != nil {
            Text("View details")
          } else {
            Text("Review permission")
          }
        }
        .accessibilityIdentifier("permission-review")
      }
    }
    .accessibilityIdentifier("permission-action-card")
    .sheet(isPresented: $showsDetails) {
      PermissionActionDetails(store: store).okouSheetBackground()
    }
  }
}

struct PermissionActionDetails: View {
  let store: PermissionActionStore
  private let read: PermissionCardRead<ChatPermissionSnapshot>

  init(store: PermissionActionStore) {
    self.store = store
    read = store.read
  }

  var body: some View {
    PermissionCardReadView(read: read) { phase in
      PermissionActionDetailsContent(store: store, phase: phase)
    }
  }
}

private struct PermissionActionDetailsContent: View {
  @Bindable var store: PermissionActionStore
  let phase: Loadable<ChatPermissionSnapshot>
  @Environment(\.dismiss) private var dismiss
  @State private var confirmingContinuation = false

  private var isLoading: Bool { phase.state == .loading }
  private var snapshot: ChatPermissionSnapshot? {
    phase.data ?? (isLoading ? store.snapshot : nil)
  }
  private var review: PermissionActionReview {
    PermissionActionReview(action: store.action, snapshot: snapshot)
  }
  private var needsContinuation: Bool { store.needsContinuation && review.applied }
  private var error: String? {
    phase.error.map(ChatRequestFailure.message(for:)) ?? store.error
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: OkouSpace.lg) {
          if snapshot != nil || error != nil {
            requestSummary
            confirmation
          }
        }
        .padding(OkouSpace.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .overlay {
        if snapshot == nil && error == nil {
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
          Text(review.metadata?.label ?? store.action.connectorSlug)
            .font(.okou(.headline)).foregroundStyle(OkouColor.foreground)
          Text("Requested by \(snapshot?.agentName ?? String(localized: "this Agent"))")
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
        if let description = review.metadata?.permissions.first(where: {
          $0.name == store.action.permission
        })?.description {
          Text(description).textSelection(.enabled)
        }
        Text(
          snapshot?.connectorScoped == true
            ? "These permissions apply to this connector across your chats and accounts."
            : "These permissions apply to your account for this Agent."
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
    if let error = error {
      // A failed read is quiet, with its retry beside it.
      if snapshot == nil && !isLoading {
        OkouLoadErrorRow(message: error, actionTitle: "Retry loading") { await store.refresh() }
      } else {
        OkouLoadErrorRow(message: error)
      }
    }
    if snapshot != nil && !review.hasPermission && !isLoading {
      Text("This permission is no longer available.")
    }
    if review.applied && !store.isSaving {
      VStack(alignment: .leading, spacing: OkouSpace.xs) {
        Label(
          store.action.action == .allow
            ? String(localized: "Allowed") : String(localized: "Denied"),
          okouSymbol: "circle-check")
        if let expiry = review.grant?.expiresAt, expiry > .now {
          Text("Expires \(expiry.formatted(date: .abbreviated, time: .shortened))")
            .okouSectionNote()
        } else if store.action.action == .allow {
          Text("No expiration").okouSectionNote()
        }
      }
    }
    if review.hasPermission && (!review.applied || needsContinuation || store.isSaving) {
      if store.action.action == .allow
        && (store.isSaving ? !confirmingContinuation : !needsContinuation)
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
          .disabled(store.isSaving || isLoading)
          .accessibilityIdentifier("permission-duration")
        }
        .font(.okou(.body))
        .frame(minHeight: OkouControl.groupedRow)
        .padding(.horizontal, OkouSpace.lg)
        .modifier(OkouSurfaceStyle())
      }
      VStack(spacing: OkouSpace.ten) {
        Button {
          confirmingContinuation = needsContinuation
          Task { [snapshot] in await store.confirm(reviewing: snapshot) }
        } label: {
          ChatSettingsActionLabel(title: confirmationTitle, isBusy: store.isSaving)
        }
        .buttonStyle(OkouButtonStyle(isPrimary: true))
        .disabled(!store.canConfirm(reviewing: snapshot) || isLoading || phase.error != nil)
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
    if needsContinuation { return "Continue chat" }
    return store.action.action == .allow ? "Allow permission" : "Deny permission"
  }
}
