import ChatData
import Observation
import SwiftUI

/// Owns the native approval cards of one conversation, keyed by the request they show, so a
/// recycled transcript row finds its loaded state instead of fetching it again.
@MainActor
final class ApprovalCardRegistry {
  private let client: APIClient
  private let didContinue: @MainActor () async -> Void
  private var mailClosed = false
  private let didFail: @MainActor (Error) -> Void
  private var mailDrafts: [String: MailDraftCardStore] = [:]
  private var shells: [String: ShellAuthorizationCardStore] = [:]

  init(
    client: APIClient, didFail: @escaping @MainActor (Error) -> Void,
    didContinue: @escaping @MainActor () async -> Void
  ) {
    self.didFail = didFail
    self.client = client
    self.didContinue = didContinue
  }

  var isMailBusy: Bool { mailDrafts.values.contains { $0.isWorking } }

  func mailDraft(_ id: String) -> MailDraftCardStore {
    if let store = mailDrafts[id] { return store }
    let store = MailDraftCardStore(id: id, client: client, didFail: didFail)
    if mailClosed { store.close() }
    mailDrafts[id] = store
    return store
  }

  /// Conversation retirement is distinct from a row detaching its shared read.
  func closeMailDrafts() {
    mailClosed = true
    for card in mailDrafts.values { card.close() }
    mailDrafts.removeAll()
  }

  func shell(_ id: String) -> ShellAuthorizationCardStore {
    if let store = shells[id] { return store }
    let store = ShellAuthorizationCardStore(id: id, client: client, didContinue: didContinue)
    shells[id] = store
    return store
  }
}

// MARK: - Desktop shell authorization

@MainActor @Observable
final class ShellAuthorizationCardStore {
  let id: String
  private(set) var authorization: ChatShellAuthorization?
  private(set) var isLoading = false
  private(set) var isWorking = false
  private(set) var error: String?
  private(set) var decisionCount = 0
  private let client: APIClient
  private let didContinue: @MainActor () async -> Void

  init(id: String, client: APIClient, didContinue: @escaping @MainActor () async -> Void) {
    self.id = id
    self.client = client
    self.didContinue = didContinue
  }

  func load() async {
    guard !isLoading, !isWorking else { return }
    isLoading = true
    defer { isLoading = false }
    do {
      authorization = try await client.shellAuthorization(id: id)
      error = nil
    } catch {
      self.error = error.localizedDescription
    }
  }

  enum Decision { case approve, deny, revoke }

  func decide(_ decision: Decision) async {
    guard !isWorking else { return }
    isWorking = true
    defer { isWorking = false }
    do {
      switch decision {
      case .approve: authorization = try await client.approveShellAuthorization(id: id)
      case .deny: authorization = try await client.denyShellAuthorization(id: id)
      case .revoke: authorization = try await client.revokeShellAuthorization(id: id)
      }
      error = nil
      decisionCount += 1
      // Approval queues the agent's next round on the server; show it arriving.
      if decision == .approve { await didContinue() }
    } catch {
      self.error = error.localizedDescription
      await load()
    }
  }
}

/// The agent asks to run commands on the user's own computer; the user decides here.
struct ShellAuthorizationCard: View {
  let store: ShellAuthorizationCardStore
  let loadsState: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: OkouSpace.md) {
      if let authorization = store.authorization {
        ChatCardHeader(
          title: String(localized: "Run commands on \(authorization.computerName)?"),
          icon: "terminal"
        ) {
          if let reason = authorization.reason, !reason.isEmpty { Text(reason) }
          Text(statusText(authorization))
        }
        if let blocked = blockedText(authorization) {
          Text(blocked).font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
        }
        HStack(spacing: OkouSpace.md) {
          switch authorization.status {
          case .pending:
            Button("Allow") { Task { await store.decide(.approve) } }
              .buttonStyle(ChatCardButtonStyle(emphasis: .primary))
              .disabled(store.isWorking || authorization.approvalBlockedReason != nil)
              .accessibilityIdentifier("shell-approve")
            Button("Deny", role: .destructive) { Task { await store.decide(.deny) } }
              .disabled(store.isWorking)
          case .approved:
            Button("Revoke access", role: .destructive) { Task { await store.decide(.revoke) } }
              .disabled(store.isWorking)
          case .denied, .revoked, .expired:
            EmptyView()
          }
          if store.isWorking { ProgressView().controlSize(.small) }
        }
      } else {
        HStack(spacing: OkouSpace.sm) {
          ProgressView().controlSize(.small)
          Text("Loading request…").font(.okou(.subheadline))
            .foregroundStyle(OkouColor.mutedForeground)
        }
        .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
      }
      if let error = store.error {
        Text(error).font(.okou(.caption)).foregroundStyle(OkouColor.destructive)
      }
    }
    .buttonStyle(ChatCardButtonStyle())
    .padding(.horizontal, OkouSpace.lg)
    .padding(.vertical, OkouSpace.md)
    .frame(maxWidth: .infinity, alignment: .leading)
    .modifier(ChatCardSurface())
    .sensoryFeedback(.success, trigger: store.decisionCount)
    .task(id: loadsState) {
      if loadsState && store.authorization == nil { await store.load() }
    }
    .accessibilityIdentifier("shell-authorization-\(store.id)")
  }

  private func statusText(_ authorization: ChatShellAuthorization) -> String {
    switch authorization.status {
    case .pending: String(localized: "Waiting for your decision")
    case .approved: String(localized: "Allowed for this chat")
    case .denied: String(localized: "Denied")
    case .revoked: String(localized: "Access revoked")
    case .expired: String(localized: "Request expired")
    }
  }

  private func blockedText(_ authorization: ChatShellAuthorization) -> String? {
    switch authorization.approvalBlockedReason {
    case "run_active": String(localized: "Wait for the current run to finish, then allow.")
    case "chat_busy": String(localized: "This chat is busy. Try again in a moment.")
    case "computer_changed": String(localized: "The chat now uses a different computer.")
    case "run_unavailable": String(localized: "The run that asked is no longer available.")
    default: nil
    }
  }
}
