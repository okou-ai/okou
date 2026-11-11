import CCStateSwiftUI
import ChatData
import SwiftUI

/// The agent's email, ready to send from the phone: who it goes to, what it says, and
/// Send / Discard. Nothing leaves until the user confirms.
struct MailDraftCard: View {
  let store: MailDraftCardStore
  let loadsState: Bool

  var body: some View {
    StoreProvider(store.stateStore) { MailDraftDemandView(store: store) }
      .id(ObjectIdentifier(store))
      .task(id: loadsState && store.isActive) { if loadsState { await store.load() } }
  }
}

private struct MailDraftDemandView: View {
  let store: MailDraftCardStore
  @LoadableValue private var requested: Loadable<Bool>

  init(store: MailDraftCardStore) {
    self.store = store
    _requested = LoadableValue(store.requested)
  }

  var body: some View {
    switch requested {
    case .hasData(true): MailDraftValueView(store: store)
    case .loading, .hasData(false): MailDraftCardContent(store: store, phase: .loading)
    case .hasError(let error): MailDraftCardContent(store: store, phase: .hasError(error))
    }
  }
}

private struct MailDraftValueView: View {
  let store: MailDraftCardStore
  @LoadableValue private var draft: Loadable<ChatMailDraft?>

  init(store: MailDraftCardStore) {
    self.store = store
    _draft = LoadableValue(task: store.value, keepLast: true)
  }

  var body: some View { MailDraftCardContent(store: store, phase: draft) }
}

private struct MailDraftCardContent: View {
  @Bindable var store: MailDraftCardStore
  let phase: Loadable<ChatMailDraft?>
  @State private var expanded = false
  @State private var confirmsSend = false
  @State private var confirmsDiscard = false

  private var draft: ChatMailDraft? { phase.data.flatMap { $0 } }
  private var isLoading: Bool { phase.state == .loading }

  var body: some View {
    VStack(alignment: .leading, spacing: OkouSpace.md) {
      if let draft = draft {
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
      } else if case .hasData(nil) = phase {
        ChatCardHeader(title: String(localized: "Email draft unavailable"), icon: "mail") {
          Text("It was sent or deleted elsewhere.")
        }
      } else if case .hasError(let error) = phase {
        OkouLoadErrorRow(message: ChatRequestFailure.message(for: error)) {
          await store.refresh()
        }
      } else {
        OkouLoadingRow("Loading email draft…")
      }
      if let error = store.error {
        Text(error).font(.okou(.caption)).foregroundStyle(OkouColor.destructive)
      }
      if store.requiresReadback && phase.error == nil {
        Button("Check draft status") { Task { await store.refresh() } }
          .disabled(store.isWorking || isLoading)
      }
    }
    .buttonStyle(ChatCardButtonStyle())
    .padding(.horizontal, OkouSpace.lg)
    .padding(.vertical, OkouSpace.md)
    .frame(maxWidth: .infinity, alignment: .leading)
    .modifier(ChatCardSurface())
    .sensoryFeedback(.success, trigger: store.sentCount)
    .confirmationDialog(
      "Send this email?", isPresented: $confirmsSend, titleVisibility: .visible
    ) {
      Button("Send") { Task { await store.send() } }
      Button("Cancel", role: .cancel) {}
    } message: {
      if let draft = draft { Text(verbatim: recipients(draft)) }
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
        .disabled(
          store.isWorking || isLoading || store.requiresReadback || draft.needsReconnect
            || draft.to.isEmpty
        )
        .accessibilityIdentifier("mail-draft-send")
        Button("Discard", role: .destructive) { confirmsDiscard = true }
          .disabled(store.isWorking || isLoading || store.requiresReadback)
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
