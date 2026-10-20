import ChatDomain
import SwiftUI

/// User-authored text stays literal; structured parts retain their order and identity.
struct UserMessageView: View {
  let message: ChatMessage
  let webURL: URL
  let viewer: MessageAttachmentStore
  let loadsAttachments: Bool

  private var document: ChatUserMessage {
    message.userMessage ?? ChatUserMessage(parts: [.init(type: "text", text: message.text)])
  }

  var body: some View {
    VStack(alignment: .trailing, spacing: 8) {
      if let annotation = document.annotation {
        UserMessageAnnotation(part: annotation, webURL: webURL)
      }
      if !message.attachments.isEmpty {
        UserMessageBubbleLayout {
          VStack(alignment: .trailing, spacing: 8) {
            ForEach(message.attachments) { attachment in
              MessageAttachmentView(
                attachment: attachment, viewer: viewer, loadsThumbnail: loadsAttachments)
            }
          }
        }
      }
      if !document.bodyParts.isEmpty || message.inputError != nil {
        UserMessageBubbleLayout {
          VStack(alignment: .leading, spacing: 10) {
            UserMessageBody(
              parts: document.bodyParts, webURL: webURL,
              sourceTitle: document.annotation?.kind == "agent"
                ? document.annotation?.titleSnapshot : nil)
            if let error = message.inputError {
              Label(error, systemImage: "exclamationmark.circle")
                .font(.subheadline).foregroundStyle(.red).textSelection(.enabled)
            }
          }
          .padding(14)
          .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .trailing)
  }
}

private struct UserMessageBody: View {
  let parts: [ChatUserMessage.Part]
  let webURL: URL
  let sourceTitle: String?

  private struct Group: Identifiable {
    let id: Int
    var parts: [ChatUserMessage.Part]
    var isFeedback: Bool { parts.first?.type == "feedback" }
  }

  private var groups: [Group] {
    var groups: [Group] = []
    for (index, part) in parts.enumerated() {
      if let previous = groups.last,
        previous.isFeedback == (part.type == "feedback"),
        !previous.isFeedback || previous.parts.first?.source == part.source
      {
        groups[groups.count - 1].parts.append(part)
      } else {
        groups.append(Group(id: index, parts: [part]))
      }
    }
    return groups
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      ForEach(groups) { group in
        if group.isFeedback {
          VStack(alignment: .leading, spacing: 10) {
            Text(feedbackHeading(group.parts)).font(.caption).foregroundStyle(.secondary)
            ForEach(Array(group.parts.enumerated()), id: \.offset) { index, part in
              if index > 0 { Divider() }
              Text(part.quote ?? "")
                .textSelection(.enabled).foregroundStyle(.secondary)
                .padding(.leading, 12)
                .overlay(alignment: .leading) { Rectangle().fill(.quaternary).frame(width: 2) }
              UserMessageInlineText(parts: part.note ?? [], webURL: webURL)
            }
          }
        } else {
          UserMessageInlineText(parts: group.parts, webURL: webURL)
        }
      }
    }
  }

  private func feedbackHeading(_ parts: [ChatUserMessage.Part]) -> String {
    if let sourceTitle { return "Quoted from \(sourceTitle)" }
    if let source = parts.first?.source, source.type == "mail" {
      return source.status == "draft" ? "Feedback on email draft" : "Feedback on sent email"
    }
    return parts.count == 1 ? "Quoted passage" : "Quoted passages"
  }
}

@MainActor
struct UserMessageInlineText: View {
  let parts: [ChatUserMessage.Part]
  let webURL: URL
  private static let links = try? NSDataDetector(
    types: NSTextCheckingResult.CheckingType.link.rawValue)

  var body: some View {
    Text(content).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
  }

  var content: AttributedString {
    parts.reduce(into: AttributedString()) { result, part in
      var text = AttributedString(part.displayText)
      switch part.type {
      case "text":
        for match in Self.links?.matches(
          in: part.displayText, range: NSRange(part.displayText.startIndex..., in: part.displayText)
        ) ?? [] {
          if let url = match.url, ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
            let range = Range(match.range, in: part.displayText),
            let start = AttributedString.Index(range.lowerBound, within: text),
            let end = AttributedString.Index(range.upperBound, within: text)
          {
            let literal = part.displayText[range].lowercased()
            guard literal.hasPrefix("https://") || literal.hasPrefix("http://") else { continue }
            if let previous = part.displayText[..<range.lowerBound].unicodeScalars.last,
              previous.isASCII && CharacterSet.alphanumerics.contains(previous)
            {
              continue
            }
            text[start..<end].link = url
          }
        }
      case "chat_thread", "agent", "template":
        text.foregroundColor = .accentColor
        text.font = .body.weight(.medium)
        text.backgroundColor = Color(uiColor: .tertiarySystemFill)
        let path: String?
        if part.type == "chat_thread", let id = part.threadId, UUID(uuidString: id) != nil {
          path = "chats/\(id)"
        } else if part.type == "agent", let id = part.agentId, UUID(uuidString: id) != nil {
          path = "agents/\(id)/chat"
        } else {
          path = nil
        }
        if let path { text.link = webURL.appending(path: path) }
      default: break
      }
      result.append(text)
    }
  }
}

private struct UserMessageAnnotation: View {
  let part: ChatUserMessage.Part
  let webURL: URL

  private var kind: String {
    if part.type == "automation" { return "automation" }
    if part.kind == "feishu", part.href?.hasPrefix("https://applink.larksuite.com/") == true {
      return "lark"
    }
    return part.kind ?? "source"
  }

  private var title: String? {
    switch kind {
    case "automation": part.workflowName
    case "agent": part.titleSnapshot
    case "mcp": part.clientName ?? "MCP"
    case "slack": "Slack"
    case "discord": "Discord"
    case "wechat": "WeChat"
    case "feishu": "Feishu"
    case "lark": "Lark"
    case "teams": "Microsoft Teams"
    case "telegram": "Telegram"
    case "github": "GitHub"
    case "agentphone": "iMessage"
    default: nil
    }
  }

  private var symbol: String {
    switch kind {
    case "automation": "point.topleft.down.to.point.bottomright.curvepath"
    case "agent": "person.crop.circle"
    case "mcp": "puzzlepiece.extension"
    case "github": "chevron.left.forwardslash.chevron.right"
    default: "bubble.left.and.bubble.right"
    }
  }

  private var destination: URL? {
    if kind == "automation", let id = part.workflowId, UUID(uuidString: id) != nil {
      return webURL.appending(path: "workflows/\(id)/automations")
    }
    if kind == "agent", let thread = part.threadId, let run = part.runId,
      UUID(uuidString: thread) != nil, UUID(uuidString: run) != nil
    {
      var url = URLComponents(
        url: webURL.appending(path: "chats/\(thread)"), resolvingAgainstBaseURL: false)
      url?.fragment = "run-\(run)"
      return url?.url
    }
    guard let href = part.href, let url = URL(string: href),
      ["http", "https", "sms"].contains(url.scheme?.lowercased() ?? ""),
      url.scheme?.lowercased() != "sms" || kind == "agentphone"
    else { return nil }
    if kind == "discord",
      href.range(
        of: #"^https://discord\.com/channels/(?:\d+|@me)/\d+/\d+$"#,
        options: .regularExpression) == nil
    {
      return nil
    }
    return url
  }

  var body: some View {
    Group {
      if let title {
        if let destination {
          Link(destination: destination) { label(title).accessibilityHint("Open source") }
        } else {
          label(title)
        }
      }
    }
    .font(.caption).foregroundStyle(.secondary)
    .accessibilityIdentifier("user-message-origin-\(kind)")
  }

  private func label(_ title: String) -> some View {
    HStack(spacing: 6) {
      if [
        "slack", "discord", "wechat", "feishu", "lark", "teams", "telegram", "github", "agentphone",
      ].contains(kind) {
        Image("MessageSource-\(kind)")
          .renderingMode(kind == "github" || kind == "slack" ? .template : .original)
          .resizable().scaledToFit().frame(width: 15, height: 15)
      } else {
        Image(systemName: symbol)
      }
      Text(title).lineLimit(1)
      if destination != nil { Image(systemName: "arrow.up.right").font(.caption2) }
    }
    .padding(.horizontal, 6).padding(.vertical, 4)
  }
}
