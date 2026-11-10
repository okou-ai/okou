import ChatData
import ChatDomain
import Observation
import SwiftUI

/// Owns the native approval cards of one conversation, keyed by the request they show, so a
/// recycled transcript row finds its loaded state instead of fetching it again.
@MainActor
final class ApprovalCardRegistry {
  private let client: APIClient
  private let didContinue: @MainActor () async -> Void
  private var mailDrafts: [String: MailDraftCardStore] = [:]
  private let thread: ChatThread
  private let commands: ChatCommands
  private let sync: ChatSync
  private let didFail: @MainActor (Error) -> Void
  private var computers: [ChatComputerAuthorizationAction: ComputerAuthorizationStore] = [:]
  private var active = false
  private var closed = false

  init(
    thread: ChatThread, commands: ChatCommands, sync: ChatSync,
    didFail: @escaping @MainActor (Error) -> Void,
    didContinue: @escaping @MainActor () async -> Void
  ) {
    self.thread = thread
    self.commands = commands
    self.sync = sync
    self.didFail = didFail
    self.client = commands.approvalClient
    self.didContinue = didContinue
  }

  func mailDraft(_ id: String) -> MailDraftCardStore {
    if let store = mailDrafts[id] { return store }
    let store = MailDraftCardStore(id: id, client: client)
    mailDrafts[id] = store
    return store
  }

  func computer(_ action: ChatComputerAuthorizationAction) -> ComputerAuthorizationStore {
    if let existing = computers[action] { return existing }
    let store = ComputerAuthorizationStore(
      action: action, thread: thread, commands: commands, sync: sync,
      didFail: didFail, didContinue: didContinue)
    computers[action] = store
    if closed { store.close() } else if active { store.activate() }
    return store
  }

  func activate() {
    active = true
    for card in computers.values { card.activate() }
  }

  func deactivate() {
    active = false
    for card in computers.values { card.deactivate() }
  }

  func refreshComputers() async {
    for card in computers.values { await card.refresh() }
  }

  func close() {
    closed = true
    for card in computers.values { card.close() }
  }

}

// MARK: - Mail draft

@MainActor @Observable
final class MailDraftCardStore {
  let id: String
  private(set) var draft: ChatMailDraft?
  private(set) var isGone = false
  private(set) var isLoading = false
  private(set) var isWorking = false
  private(set) var error: String?
  private(set) var sentCount = 0
  private let client: APIClient

  init(id: String, client: APIClient) {
    self.id = id
    self.client = client
  }

  func load() async {
    guard !isLoading, !isWorking else { return }
    isLoading = true
    defer { isLoading = false }
    do {
      draft = try await client.mailDraft(id: id)
      isGone = draft == nil
      error = nil
    } catch {
      self.error = error.localizedDescription
    }
  }

  func send() async {
    guard !isWorking else { return }
    isWorking = true
    defer { isWorking = false }
    do {
      draft = try await client.sendMailDraft(id: id)
      error = nil
      sentCount += 1
    } catch let failure as APIClientError where failure.statusCode == 400 {
      error = String(localized: "The mail provider rejected this email. Check the recipients.")
      await load()
    } catch let failure as APIClientError where failure.statusCode == 409 {
      error = String(localized: "This draft can no longer be sent.")
      await load()
    } catch {
      self.error = error.localizedDescription
    }
  }

  func discard() async {
    guard !isWorking else { return }
    isWorking = true
    defer { isWorking = false }
    do {
      try await client.discardMailDraft(id: id)
      error = nil
      await load()
    } catch {
      self.error = error.localizedDescription
    }
  }
}

/// The agent's email, ready to send from the phone: who it goes to, what it says, and
/// Send / Discard. Nothing leaves until the user confirms.
struct MailDraftCard: View {
  let store: MailDraftCardStore
  let loadsState: Bool
  @State private var expanded = false
  @State private var confirmsSend = false
  @State private var confirmsDiscard = false

  var body: some View {
    VStack(alignment: .leading, spacing: OkouSpace.md) {
      if let draft = store.draft {
        ChatCardHeader(
          title: draft.subject.isEmpty ? String(localized: "(No subject)") : draft.subject,
          icon: "mail"
        ) {
          Text(verbatim: recipients(draft)).lineLimit(2)
          Text(statusText(draft))
        }
        if draft.detailAvailable {
          Text(draft.body)
            .font(.okou(.subheadline))
            .foregroundStyle(OkouColor.foreground)
            .lineLimit(expanded ? nil : 4)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
          if draft.body.count > 160 {
            Button(expanded ? "Show less" : "Show full email") { expanded.toggle() }
              .font(.okou(.caption))
          }
          if !draft.attachments.isEmpty {
            Label(
              "\(draft.attachments.count) attachments", okouSymbol: "file",
              iconSize: OkouIconSize.inline
            )
            .font(.okou(.caption)).foregroundStyle(OkouColor.mutedForeground)
          }
        }
        if draft.needsReconnect {
          Text("Reconnect your mail account on the web to send this draft.")
            .font(.okou(.caption)).foregroundStyle(OkouColor.mutedForeground)
        }
        actions(draft)
      } else if store.isGone {
        ChatCardHeader(title: String(localized: "Email draft unavailable"), icon: "mail") {
          Text("It was sent or deleted elsewhere.")
        }
      } else {
        HStack(spacing: OkouSpace.sm) {
          ProgressView().controlSize(.small)
          Text("Loading email draft…").font(.okou(.subheadline))
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
    .sensoryFeedback(.success, trigger: store.sentCount)
    .task(id: loadsState) {
      if loadsState && store.draft == nil && !store.isGone { await store.load() }
    }
    .confirmationDialog(
      "Send this email?", isPresented: $confirmsSend, titleVisibility: .visible
    ) {
      Button("Send") { Task { await store.send() } }
      Button("Cancel", role: .cancel) {}
    } message: {
      if let draft = store.draft { Text(verbatim: recipients(draft)) }
    }
    .confirmationDialog(
      "Discard this draft?", isPresented: $confirmsDiscard, titleVisibility: .visible
    ) {
      Button("Discard", role: .destructive) { Task { await store.discard() } }
      Button("Cancel", role: .cancel) {}
    }
    .accessibilityIdentifier("mail-draft-\(store.id)")
  }

  @ViewBuilder private func actions(_ draft: ChatMailDraft) -> some View {
    if draft.status == .draft && draft.detailAvailable {
      HStack(spacing: OkouSpace.md) {
        Button {
          confirmsSend = true
        } label: {
          HStack(spacing: OkouSpace.xs) {
            if store.isWorking { ProgressView().controlSize(.mini) }
            Text("Send")
          }
        }
        .buttonStyle(ChatCardButtonStyle(emphasis: .primary))
        .disabled(store.isWorking || draft.needsReconnect || draft.to.isEmpty)
        .accessibilityIdentifier("mail-draft-send")
        Button("Discard", role: .destructive) { confirmsDiscard = true }
          .disabled(store.isWorking)
        if let link = providerLink(draft) {
          Link(draft.provider == "outlook" ? "Outlook" : "Gmail", destination: link)
        }
      }
    }
  }

  private func providerLink(_ draft: ChatMailDraft) -> URL? {
    if draft.provider == "outlook" { return draft.outlookWebLink }
    return URL(string: "https://mail.google.com/mail/u/0/#drafts")
  }

  private func recipients(_ draft: ChatMailDraft) -> String {
    var parts = [String(localized: "To: \(draft.to.joined(separator: ", "))")]
    if !draft.cc.isEmpty {
      parts.append(String(localized: "Cc: \(draft.cc.joined(separator: ", "))"))
    }
    return parts.joined(separator: " · ")
  }

  private func statusText(_ draft: ChatMailDraft) -> String {
    switch draft.status {
    case .draft: String(localized: "Draft · not sent")
    case .sending: String(localized: "Sending…")
    case .sent: String(localized: "Sent")
    case .deleted: String(localized: "Discarded")
    }
  }
}
