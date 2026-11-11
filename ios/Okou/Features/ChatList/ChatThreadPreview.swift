import CCStateSwiftUI
import ChatDomain
import SwiftUI

/// The system owns the lift, dimming and menu; the card is a read-only glimpse of the chat.
struct ChatThreadPreview: View {
  let thread: ChatThread
  let workspace: WorkspaceStore

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: OkouSpace.sm) {
        if let emoji = thread.titleParts.emoji { Text(verbatim: emoji) }
        Text(verbatim: thread.titleParts.text)
          .font(.okou(.headline)).lineLimit(1)
      }
      .padding(OkouSpace.lg)
      OkouListDivider()
      Group {
        if let resource = workspace.threadPreview, resource.threadID == thread.id {
          StoreProvider(resource.store) {
            ChatThreadPreviewBody(resource: resource)
          }
          .id(ObjectIdentifier(resource))
        } else {
          OkouLoadingRow("Loading chat")
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .padding(OkouSpace.lg)
    }
    // Leave room for the existing menu on compact iPhones. The system may scale the whole preview.
    .frame(width: 320, height: 300)
    .foregroundStyle(OkouColor.foreground)
    .background(OkouColor.background)
    .clipShape(RoundedRectangle(cornerRadius: OkouRadius.card, style: .continuous))
    .accessibilityIdentifier("chat-preview-\(thread.id)")
    .onAppear { workspace.previewChat(thread.id) }
    .onDisappear { workspace.dismissChatPreview(thread.id) }
  }
}

private struct ChatThreadPreviewBody: View {
  @LoadableValue private var content: Loadable<ChatThreadPreviewContent>

  init(resource: ChatThreadPreviewResources) {
    _content = LoadableValue(task: resource.content)
  }

  var body: some View {
    switch content {
    case .loading:
      OkouLoadingRow("Loading chat")
    case .hasError:
      VStack(alignment: .leading, spacing: OkouSpace.sm) {
        Label("Preview unavailable", okouSymbol: "messages-square")
          .font(.okou(.body).weight(.medium))
        Text("Open the chat to try again.")
          .font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
      }
    case .hasData(let content):
      VStack(alignment: .leading, spacing: OkouSpace.lg) {
        if content.messages.isEmpty && !content.isWorking {
          Text("No messages yet")
            .font(.okou(.body)).foregroundStyle(OkouColor.mutedForeground)
        }
        ForEach(content.messages) { message in
          ChatThreadPreviewMessage(message: message)
        }
        if content.isWorking {
          HStack(spacing: OkouSpace.sm) {
            OkouRunningIndicator()
            Text("Working").font(.okou(.footnote))
          }
          .foregroundStyle(OkouColor.mutedForeground)
        }
      }
    }
  }
}

private struct ChatThreadPreviewMessage: View {
  let message: ChatMessage

  var body: some View {
    VStack(alignment: .leading, spacing: OkouSpace.six) {
      HStack(spacing: OkouSpace.six) {
        if message.role == .assistant {
          OkouAgentAvatar(avatarURL: nil, name: "Okou", isDefault: true, size: OkouIconSize.menu)
        }
        Text(message.role == .user ? String(localized: "You") : "Okou")
          .font(.okou(.footnote).weight(.medium))
        Spacer(minLength: 0)
        Text(message.createdAt, style: .time)
          .font(.okou(.caption)).foregroundStyle(OkouColor.mutedForeground)
      }
      if !message.copyText.isEmpty {
        Text(previewText)
          .font(.okou(.body))
          .lineLimit(message.role == .user ? 2 : 4)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      if let attachment = message.attachments.first {
        Label(attachment.filename, okouSymbol: "paperclip")
          .font(.okou(.footnote)).lineLimit(1).foregroundStyle(OkouColor.mutedForeground)
      }
    }
    .padding(message.role == .user ? OkouSpace.md : 0)
    .background {
      if message.role == .user {
        RoundedRectangle(cornerRadius: OkouRadius.chat).fill(OkouColor.gray200)
      }
    }
  }

  private var previewText: AttributedString {
    let text = String(message.copyText.prefix(2000))
    guard message.role == .assistant else { return AttributedString(text) }
    // Parse only bounded text; previews never resolve links, attachments or action cards.
    return (try? AttributedString(markdown: text)) ?? AttributedString(text)
  }
}
