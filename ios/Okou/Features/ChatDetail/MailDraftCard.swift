import CCStateSwiftUI
import ChatData
import SwiftUI

struct MailDraftCard: View {
  let store: MailDraftCardStore
  let loadsState: Bool

  var body: some View {
    StoreProvider(store.stateStore) {
      if loadsState || store.hasRequestedValue {
        MailDraftCardValue(store: store)
      } else {
        MailDraftCardContent(store: store, value: .loading)
      }
    }
    .id(ObjectIdentifier(store))
  }
}

private struct MailDraftCardValue: View {
  let store: MailDraftCardStore
  @LoadableValue private var value: Loadable<ChatMailDraft?>

  init(store: MailDraftCardStore) {
    self.store = store
    _value = LoadableValue(task: store.value)
  }

  var body: some View { MailDraftCardContent(store: store, value: value) }
}

/// The agent's email, ready to send from the phone: who it goes to, what it says, and
/// Send / Discard. Nothing leaves until the user confirms.
private struct MailDraftCardContent: View {
  let store: MailDraftCardStore
  let value: Loadable<ChatMailDraft?>
  @State private var expanded = false
  @State private var confirmsSend = false
  @State private var confirmsDiscard = false

  var body: some View {
    VStack(alignment: .leading, spacing: OkouSpace.md) {
      if let draft = value.data ?? nil {
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
      } else if isUnavailable {
        ChatCardHeader(title: String(localized: "Email draft unavailable"), icon: "mail") {
          Text("It was sent or deleted elsewhere.")
        }
      } else if let error = value.error {
        ChatCardHeader(title: String(localized: "Email draft unavailable"), icon: "mail") {
          Text(error.localizedDescription)
        }
        Button("Retry") { store.retry() }
          .disabled(store.isWorking || store.requiresUpgrade)
          .accessibilityIdentifier("mail-draft-retry")
      } else {
        HStack(spacing: OkouSpace.sm) {
          ProgressView().controlSize(.small)
          Text("Loading email draft…").font(.okou(.subheadline))
            .foregroundStyle(OkouColor.mutedForeground)
        }
        .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
      }
      if let error = store.mutationError {
        Text(error).font(.okou(.caption)).foregroundStyle(OkouColor.destructive)
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
      if let draft = value.data ?? nil { Text(verbatim: recipients(draft)) }
    }
    .confirmationDialog(
      "Discard this draft?", isPresented: $confirmsDiscard, titleVisibility: .visible
    ) {
      Button("Discard", role: .destructive) { Task { await store.discard() } }
      Button("Cancel", role: .cancel) {}
    }
    .accessibilityIdentifier("mail-draft-\(store.id)")
  }

  private var isUnavailable: Bool {
    if case .hasData(nil) = value { return true }
    return false
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
          store.isWorking || store.requiresUpgrade || draft.needsReconnect || draft.to.isEmpty
        )
        .accessibilityIdentifier("mail-draft-send")
        Button("Discard", role: .destructive) { confirmsDiscard = true }
          .disabled(store.isWorking || store.requiresUpgrade)
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
