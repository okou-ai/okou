import CCStateSwiftUI
import ChatData
import SwiftUI

struct SSHAuthorizationCard: View {
  let store: SSHAuthorizationStore
  let loadsState: Bool
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    StoreProvider(store.stateStore) {
      if loadsState && store.isActive {
        SSHAuthorizationCardValue(store: store)
      } else {
        SSHAuthorizationCardContent(
          action: store.action, request: nil, loading: true, working: false, error: nil,
          decide: { _ in }, refresh: {})
      }
    }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active && loadsState { Task { await store.refresh() } }
    }
    .accessibilityElement(children: .contain)
  }
}

private struct SSHAuthorizationCardValue: View {
  let store: SSHAuthorizationStore
  @LoadableValue private var value: Loadable<ChatSSHAuthorization>

  init(store: SSHAuthorizationStore) {
    self.store = store
    _value = LoadableValue(task: store.request, keepLast: true)
  }

  var body: some View {
    SSHAuthorizationCardContent(
      action: store.action, request: value.error == nil ? value.data : nil,
      loading: value.state == .loading, working: store.isWorking,
      error: value.error.map(ChatRequestFailure.message(for:)) ?? store.error,
      decide: store.decide, refresh: store.refresh
    )
    .task(id: deadline) {
      guard let deadline else { return }
      do {
        try await Task.sleep(for: .seconds(max(0, deadline.timeIntervalSinceNow)))
        try Task.checkCancellation()
        await store.refresh()
      } catch is CancellationError {
      } catch {
        // Refresh retains failures in the original request, with an explicit retry.
      }
    }
  }

  private var deadline: Date? {
    value.data?.status == .pending ? value.data?.requestExpiresAt : nil
  }
}

/// Shared by the transcript and the on-demand native component catalog.
struct SSHAuthorizationCardContent: View {
  let action: ChatSSHAuthorizationAction
  let request: ChatSSHAuthorization?
  let loading: Bool
  let working: Bool
  let error: String?
  let decide: (SSHAuthorizationStore.Decision) async -> Void
  let refresh: () async -> Void
  @State private var showsDetails = false
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  var body: some View {
    TimelineView(.explicit(request.map { [$0.requestExpiresAt] } ?? [])) { _ in
      let status = request?.effectiveStatus(at: .now)
      ChatActionCard {
        ChatCardHeader(
          title: title(status), icon: status == .approved ? "check" : "shield-check"
        ) {
          if let request {
            Text(verbatim: request.target).textSelection(.enabled)
            Text("This host · This chat only")
          } else {
            Text(
              loading
                ? String(localized: "Loading request…")
                : String(localized: "SSH request unavailable"))
          }
          if let message = message(status) {
            Text(message)
              .foregroundStyle(error == nil ? OkouColor.mutedForeground : OkouColor.destructive)
              .accessibilityAddTraits(.updatesFrequently)
          }
        }
      } actions: {
        VStack(alignment: .leading, spacing: OkouSpace.sm) {
          if dynamicTypeSize.isAccessibilitySize {
            VStack(spacing: OkouSpace.sm) { controls(status) }
          } else {
            ViewThatFits(in: .horizontal) {
              HStack(spacing: OkouSpace.sm) { controls(status) }
                .fixedSize(horizontal: true, vertical: false)
              VStack(spacing: OkouSpace.sm) { controls(status) }
            }
          }
          if status == .pending && error == nil && request?.approvalBlockedReason == nil {
            Text("The task continues automatically after you allow access.")
              .font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
          }
        }
      }
      .sheet(isPresented: $showsDetails) {
        SSHAuthorizationDetails(action: action, request: request, error: error)
          .presentationDetents([.medium, .large])
          .okouSheetBackground()
      }
    }
  }

  private func title(_ status: ChatSSHAuthorization.Status?) -> String {
    let title: String
    switch status {
    case .approved: title = String(localized: "SSH access allowed")
    case .revoked: title = String(localized: "SSH access revoked")
    case .denied: title = String(localized: "SSH access denied")
    case .expired: title = String(localized: "SSH request expired")
    case .stale: title = String(localized: "SSH request changed")
    case .pending, nil: title = String(localized: "SSH access")
    }
    if let request { return String(localized: "\(title) · \(request.displayName)") }
    return title
  }

  private func message(_ status: ChatSSHAuthorization.Status?) -> String? {
    if error != nil {
      return String(localized: "Unable to confirm the result. Check the request status.")
    }
    if let blocker = request?.approvalBlockedReason { return sshApprovalBlocker(blocker) }
    switch status {
    case .expired, .stale: return String(localized: "Ask for a new request in this chat.")
    default: return nil
    }
  }

  @ViewBuilder private func controls(_ status: ChatSSHAuthorization.Status?) -> some View {
    if let request {
      if status == .pending {
        Button {
          Task { await decide(.approve) }
        } label: {
          HStack(spacing: OkouSpace.sm) {
            if working { ProgressView().controlSize(.small).tint(OkouColor.primaryForeground) }
            Text("Allow in this chat")
          }
        }
        .buttonStyle(ChatCardButtonStyle(emphasis: .primary))
        .disabled(loading || working || request.approvalBlockedReason != nil)
        .accessibilityIdentifier("ssh-authorization-approve")
      }
      if status == .approved {
        Button("Revoke access", role: .destructive) { Task { await decide(.revoke) } }
          .disabled(loading || working)
          .accessibilityIdentifier("ssh-authorization-revoke")
      } else {
        Button("Access details") { showsDetails = true }
          .buttonStyle(ChatCardButtonStyle(emphasis: .detail))
          .accessibilityIdentifier("ssh-authorization-details")
      }
    } else if !loading {
      Button("Check status") { Task { await refresh() } }.disabled(working)
        .accessibilityIdentifier("ssh-authorization-refresh")
      Link("View on Web", destination: action.originalURL)
        .buttonStyle(ChatCardButtonStyle(emphasis: .detail))
    } else {
      OkouLoadingRow("Loading request…")
    }
    if request != nil && status == .approved {
      Button("Access details") { showsDetails = true }
        .buttonStyle(ChatCardButtonStyle(emphasis: .detail))
        .accessibilityIdentifier("ssh-authorization-details")
    }
  }
}

private struct SSHAuthorizationDetails: View {
  let action: ChatSSHAuthorizationAction
  let request: ChatSSHAuthorization?
  let error: String?
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: OkouSpace.lg) {
          if let request {
            detail("Host", value: request.displayName)
            detail("Remote user and address", value: request.target)
            detail("Access scope", value: String(localized: "This host · This chat only"))
            detail("Purpose", value: request.reason)
            Text(
              "Allow commands and file transfers as this remote user until access is turned off."
            )
            .okouSectionNote()
            if let blocker = request.approvalBlockedReason {
              Text(sshApprovalBlocker(blocker)).okouSectionNote()
            }
            if !request.requiredPermissions.isEmpty {
              VStack(alignment: .leading, spacing: OkouSpace.sm) {
                Text("Required connector permissions").font(.okou(.headline))
                ForEach(request.requiredPermissions) { item in
                  Text(verbatim: "\(item.connectorSlug) / \(item.permission)")
                    .font(.okou(.subheadline)).textSelection(.enabled)
                }
                Text("Approve these separately using the permission cards in this chat.")
                  .okouSectionNote()
              }
            }
          }
          if let error { Text(error).foregroundStyle(OkouColor.destructive) }
          Link("View on Web", destination: action.originalURL)
            .buttonStyle(ChatCardButtonStyle(emphasis: .detail))
        }
        .padding(OkouControl.pageInset)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .background(OkouColor.background)
      .navigationTitle("Access details")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { OkouCloseToolbarItem { dismiss() } }
    }
  }

  private func detail(_ title: LocalizedStringKey, value: String) -> some View {
    VStack(alignment: .leading, spacing: OkouSpace.xs) {
      Text(title).font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
      Text(verbatim: value).font(.okou(.body)).textSelection(.enabled)
    }
  }
}

private func sshApprovalBlocker(_ reason: String) -> String {
  switch reason {
  case "run_active", "chat_busy":
    String(localized: "Wait for the current task to finish before allowing access.")
  case "permissions_required":
    String(localized: "Approve the required connector permissions first.")
  case "host_changed": String(localized: "The host configuration changed. Ask for a new request.")
  case "run_unavailable":
    String(localized: "The requesting run is unavailable. Ask for a new request.")
  default: String(localized: "This request cannot be approved right now.")
  }
}
