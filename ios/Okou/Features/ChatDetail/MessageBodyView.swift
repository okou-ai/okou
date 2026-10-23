import ChatData
import ChatDomain
import SwiftUI
import Textual

struct MessageActionContext: Equatable {
  let agentID: String
  let threadID: String
}

struct MessageBodyView: View, Equatable {
  let text: String
  let baseURL: URL
  let markdown: MessageMarkdownCache
  let actionContext: MessageActionContext?
  let connectorActions: ConnectorActionStore?
  let permissionActions: PermissionActionRegistry?
  let artifacts: MessageArtifactStore?
  let artifactImageSources: [String]
  let loadsActions: Bool
  @Environment(\.openURL) private var openURL
  private struct Prepared {
    let source: String
    let content: AttributedString
  }
  @State private var prepared: Prepared?

  init(
    text: String, baseURL: URL, markdown: MessageMarkdownCache,
    actionContext: MessageActionContext? = nil, connectorActions: ConnectorActionStore? = nil,
    permissionActions: PermissionActionRegistry? = nil,
    artifacts: MessageArtifactStore? = nil, artifactImageSources: [String] = [],
    loadsActions: Bool = false
  ) {
    self.text = text
    self.baseURL = baseURL
    self.markdown = markdown
    self.actionContext = actionContext
    self.connectorActions = connectorActions
    self.permissionActions = permissionActions
    self.artifacts = artifacts
    self.artifactImageSources = artifactImageSources
    self.loadsActions = loadsActions
    _prepared = State(
      initialValue: markdown.cached(text).map { Prepared(source: text, content: $0) })
  }

  nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.text == rhs.text && lhs.baseURL == rhs.baseURL && lhs.markdown === rhs.markdown
      && lhs.actionContext == rhs.actionContext && lhs.connectorActions === rhs.connectorActions
      && lhs.permissionActions === rhs.permissionActions
      && lhs.artifacts === rhs.artifacts && lhs.artifactImageSources == rhs.artifactImageSources
      && lhs.loadsActions == rhs.loadsActions
  }

  @ViewBuilder private func preparedBody(_ content: AttributedString) -> some View {
    if let context = actionContext, let connectorActions {
      let blocks = MessageActionBody.blocks(
        content, webURL: baseURL, agentID: context.agentID, threadID: context.threadID,
        permissionsEnabled: permissionActions != nil)
      VStack(alignment: .leading, spacing: 12) {
        ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
          switch block {
          case .markdown(let fragment):
            if !String(fragment.characters).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            {
              artifactBody(fragment)
            }
          case .connector(let action):
            ConnectorActionCard(action: action, store: connectorActions, loadsState: loadsActions)
          case .permission(let action):
            if let permissionActions {
              PermissionActionCard(store: permissionActions.card(action), loadsState: loadsActions)
            }
          case .unavailablePermission:
            Label("Permission request unavailable", systemImage: "exclamationmark.shield")
              .font(.subheadline).foregroundStyle(.secondary)
              .padding(14).frame(maxWidth: .infinity, minHeight: 220, alignment: .leading)
              .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
          }
        }
      }
    } else {
      artifactBody(content)
    }
  }

  @ViewBuilder private func artifactBody(_ content: AttributedString) -> some View {
    if let artifacts {
      let images =
        prepared.map { MessageArtifactBody.resources($0.content, viewer: artifacts) } ?? []
      let blocks = MessageArtifactBody.blocks(content, viewer: artifacts)
      VStack(alignment: .leading, spacing: 8) {
        ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
          switch block {
          case .markdown(let fragment):
            if !String(fragment.characters).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            {
              StructuredText(text, parser: PreparedMessageParser(content: fragment))
            }
          case .artifact(let resource, let label, let destination):
            MessageArtifactCard(
              resource: resource, label: label, destination: destination,
              images: images, imageSources: artifactImageSources, viewer: artifacts,
              loadsContent: loadsActions)
          }
        }
      }
    } else {
      StructuredText(text, parser: PreparedMessageParser(content: content))
    }
  }

  var body: some View {
    Group {
      if let prepared, prepared.source == text {
        preparedBody(prepared.content)
      } else {
        Text(text).textSelection(.enabled)
      }
    }
    // Keep overrides closest to the content; the bundled style sets the same environment keys.
    .textual.codeBlockStyle(MessageCodeBlockStyle())
    .textual.tableStyle(.overflow)
    .textual.structuredTextStyle(.gitHub)
    .textual.imageAttachmentLoader(
      MessageImageLoader(baseURL: baseURL, artifacts: artifacts, loadsContent: loadsActions)
    )
    .textual.textSelection(.enabled)
    .frame(maxWidth: .infinity, alignment: .leading)
    .environment(
      \.openURL,
      OpenURLAction { url in
        guard ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "") else {
          return .discarded
        }
        if let artifacts, let resource = artifacts.resource(url.absoluteString) {
          let images =
            prepared.map { MessageArtifactBody.resources($0.content, viewer: artifacts) } ?? []
          artifacts.open(resource, images: images, imageSources: artifactImageSources)
        } else {
          // Markdown links can retain a base URL. System dispatch needs the
          // resolved standalone destination, even when absoluteString is valid.
          openURL(url.absoluteURL)
        }
        return .handled
      }
    )
    .task(id: text) {
      let content = await markdown.content(for: text)
      guard !Task.isCancelled else { return }
      prepared = Prepared(source: text, content: content)
    }
  }
}

private struct MessageCodeBlockStyle: StructuredText.CodeBlockStyle {
  func makeBody(configuration: Configuration) -> some View {
    let language = configuration.languageHint ?? ""
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text(language.isEmpty ? "Code" : language)
          .font(.caption)
          .foregroundStyle(.secondary)
        Spacer()
        Button {
          configuration.codeBlock.copyToPasteboard()
        } label: {
          Image(systemName: "doc.on.doc")
        }
        .buttonStyle(.borderless)
        .accessibilityLabel("Copy code")
      }
      // Textual's overflow container keeps text selection local to this code block.
      Overflow {
        configuration.label
          .textual.fontScale(0.85)
          .monospaced()
          .fixedSize(horizontal: false, vertical: true)
          .padding(.vertical, 2)
      }
    }
    .padding(12)
    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
    .textual.blockSpacing(.init(top: 0, bottom: 16))
  }
}

private struct MessageImageLoader: AttachmentLoader {
  let baseURL: URL
  let artifacts: MessageArtifactStore?
  let loadsContent: Bool

  private var loader: some AttachmentLoader { .image(relativeTo: baseURL) }

  func attachment(
    for url: URL, text: String, environment: ColorEnvironmentValues
  ) async throws -> some Textual.Attachment {
    let resolved = URL(string: url.absoluteString, relativeTo: baseURL)?.absoluteURL ?? url
    guard ["https", "http"].contains(resolved.scheme?.lowercased() ?? "") else {
      throw URLError(.unsupportedURL)
    }
    if let artifacts, let resource = await artifacts.resource(resolved.absoluteString) {
      guard loadsContent else { throw CancellationError() }
      let card = try await artifacts.card(resource, thumbnail: true)
      guard let data = card.thumbnail else { throw APIClientError.invalidResponse }
      let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(
        UUID().uuidString + ".png")
      try data.write(to: temporary)
      defer { try? FileManager.default.removeItem(at: temporary) }
      let erase: (any Textual.Attachment) -> AnyAttachment = AnyAttachment.init
      return erase(
        try await loader.attachment(for: temporary, text: text, environment: environment))
    }
    let erase: (any Textual.Attachment) -> AnyAttachment = AnyAttachment.init
    return erase(try await loader.attachment(for: resolved, text: text, environment: environment))
  }
}

#Preview("Markdown message") {
  ScrollView {
    MessageBodyView(
      text: """
        # A complete answer

        A paragraph with **bold**, *italic*, `inline code`, and a [safe link](/chats).

        ## Next steps

        1. Review the result.
        2. Run the example:
           - Keep the input unchanged.
           - Compare the output.

        > A quoted explanation can contain **formatting** too.

        | Feature | Result |
        | --- | --- |
        | Headings and lists | Native layout |
        | Tables and code | Horizontal scrolling when needed |

        ```swift
        let answer = "Hello, Okou"
        print(answer)
        ```
        """,
      baseURL: URL(string: "https://app.okou.ai")!,
      markdown: MessageMarkdownCache(baseURL: URL(string: "https://app.okou.ai")!)
    )
    .padding(20)
  }
}
