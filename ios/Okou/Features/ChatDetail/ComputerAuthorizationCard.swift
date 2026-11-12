import CCStateSwiftUI
import ChatData
import SwiftUI

struct ComputerAuthorizationCard: View {
  let store: ComputerAuthorizationStore
  let loadsState: Bool
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    StoreProvider(store.stateStore) {
      if loadsState && store.isActive {
        ComputerAuthorizationCardValue(store: store)
      } else {
        ComputerAuthorizationCardContent(
          kind: store.action.kind, request: nil, loading: true, error: nil,
          isWorking: false, needsContinuation: false, hasContinued: false,
          selectedHostID: .constant(nil), decide: { _ in }, retry: {})
      }
    }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active && loadsState { Task { await store.refresh() } }
    }
    .accessibilityIdentifier("computer-authorization-\(store.action.kind.rawValue)")
  }
}

private struct ComputerAuthorizationCardValue: View {
  let store: ComputerAuthorizationStore
  @LoadableValue private var value: Loadable<ChatComputerAuthorizationRequest>

  init(store: ComputerAuthorizationStore) {
    self.store = store
    _value = LoadableValue(task: store.request, keepLast: true)
  }

  var body: some View {
    ComputerAuthorizationCardContent(
      kind: store.action.kind, request: value.data, loading: value.state == .loading,
      error: store.error ?? value.error.map(ChatRequestFailure.message(for:)),
      isWorking: store.isWorking, needsContinuation: store.needsContinuation,
      hasContinued: store.hasContinued,
      selectedHostID: Binding(
        get: { value.data.flatMap(store.selectedHost(in:)) },
        set: { store.selectHost($0) }),
      decide: { decision in Task { await store.decide(decision) } },
      retry: { Task { await store.refresh() } })
  }
}

/// The same native presentation is used by the transcript and the Debug catalog.
struct ComputerAuthorizationCardContent: View {
  let kind: ChatComputerAuthorizationAction.Kind
  let request: ChatComputerAuthorizationRequest?
  let loading: Bool
  let error: String?
  let isWorking: Bool
  let needsContinuation: Bool
  let hasContinued: Bool
  @Binding var selectedHostID: String?
  let decide: (ComputerAuthorizationStore.Decision) -> Void
  let retry: () -> Void
  @ScaledMetric(relativeTo: .body) private var informationHeight: CGFloat = 80

  var body: some View {
    TimelineView(.explicit(request.map { [$0.expiresAt] } ?? [])) { _ in
      let status = request?.effectiveStatus(at: .now)
      ChatActionCard {
        ChatCardHeader(title: title, icon: icon) {
          if kind == .shell {
            Text(request?.computerName ?? String(localized: "Your computer"))
              .lineLimit(1, reservesSpace: true)
            Text(description(status)).lineLimit(1, reservesSpace: true)
          } else {
            Text(description(status)).lineLimit(2, reservesSpace: true)
          }
          Text(error ?? " ").foregroundStyle(OkouColor.destructive)
            .lineLimit(1, reservesSpace: true).accessibilityHidden(error == nil)
        }
        .frame(minHeight: informationHeight, alignment: .top)
      } actions: {
        VStack(alignment: .leading, spacing: OkouSpace.sm) {
          if kind == .computerUse {
            Picker("Computer", selection: $selectedHostID) {
              Text("Select computer").tag(nil as String?)
              ForEach(request?.hosts.filter { $0.status == "online" } ?? []) { host in
                Text(verbatim: host.displayName).tag(Optional(host.id))
              }
            }
            .pickerStyle(.menu)
            .disabled(isWorking || status != .pending)
            .accessibilityIdentifier("authorization-computer")
          }
          controls(status)
        }
      }
      .sensoryFeedback(.success, trigger: hasContinued)
    }
  }

  private var title: String {
    switch kind {
    case .computerUse: String(localized: "Computer Use")
    case .browser: String(localized: "Cloud Browser")
    case .shell: String(localized: "Shell access")
    }
  }

  private var icon: String {
    switch kind {
    case .computerUse: "monitor"
    case .browser: "globe"
    case .shell: "terminal"
    }
  }

  private var approvalLabel: String {
    kind == .shell ? String(localized: "Allow for 1 hour") : String(localized: "Authorize")
  }

  private func description(_ status: ChatShellAuthorization.Status?) -> String {
    if loading { return String(localized: "Loading request…") }
    guard let status else { return String(localized: "Authorization unavailable") }
    switch status {
    case .approved:
      if hasContinued { return String(localized: "Authorized · Chat continued") }
      if needsContinuation { return String(localized: "Authorized · Tap again to continue chat") }
      return kind == .shell
        ? String(localized: "Allowed for 1 hour") : String(localized: "Authorized for this chat")
    case .denied: return String(localized: "Denied")
    case .revoked: return String(localized: "Access revoked")
    case .expired: return String(localized: "Request expired")
    case .pending:
      switch request?.approvalBlockedReason {
      case "run_active": return String(localized: "Wait for the current run to finish, then allow.")
      case "chat_busy": return String(localized: "This chat is busy. Try again in a moment.")
      case "computer_changed": return String(localized: "The chat now uses a different computer.")
      case "run_unavailable": return String(localized: "The run that asked is no longer available.")
      default: break
      }
      if kind == .computerUse {
        return request?.hosts.contains { $0.status == "online" } == true
          ? String(localized: "Choose a computer to use for this chat.")
          : String(localized: "Open Okou on your computer to bring it online.")
      }
      if kind == .browser { return String(localized: "Enable Cloud Browser for this chat.") }
      let name = request?.computerName ?? ""
      return request?.reason ?? String(localized: "Run commands on \(name)?")
    }
  }

  @ViewBuilder private func controls(_ status: ChatShellAuthorization.Status?) -> some View {
    HStack(spacing: OkouSpace.sm) {
      if loading || isWorking { ProgressView().controlSize(.small) }
      if status == .pending || (status == .approved && needsContinuation) {
        Button(approvalLabel) { decide(.approve) }
          .buttonStyle(ChatCardButtonStyle(emphasis: .primary))
          .disabled(
            loading || isWorking || request?.approvalBlockedReason != nil
              || (kind == .computerUse && status == .pending && selectedHostID == nil)
          )
          .accessibilityIdentifier("authorization-approve")
        if kind == .shell && status == .pending {
          Button("Deny", role: .destructive) { decide(.deny) }.disabled(isWorking)
        }
      } else if status == .approved {
        if kind == .shell {
          Button("Revoke access", role: .destructive) { decide(.revoke) }.disabled(isWorking)
        } else {
          Label("Authorized", okouSymbol: "circle-check")
        }
      } else if !loading {
        Button("Refresh", action: retry).disabled(isWorking)
      }
    }
    .frame(minHeight: OkouControl.minimumTarget)
  }
}
