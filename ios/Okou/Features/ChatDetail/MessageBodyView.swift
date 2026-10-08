import SwiftUI
import Textual

struct MessageBodyView: View, Equatable {
  let text: String
  let baseURL: URL
  let markdown: MessageMarkdownCache
  private struct Prepared {
    let source: String
    let content: AttributedString
  }
  @State private var prepared: Prepared?

  init(text: String, baseURL: URL, markdown: MessageMarkdownCache) {
    self.text = text
    self.baseURL = baseURL
    self.markdown = markdown
    _prepared = State(
      initialValue: markdown.cached(text).map { Prepared(source: text, content: $0) })
  }

  nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.text == rhs.text && lhs.baseURL == rhs.baseURL && lhs.markdown === rhs.markdown
  }

  var body: some View {
    Group {
      if let prepared, prepared.source == text {
        StructuredText(text, parser: PreparedMessageParser(content: prepared.content))
      } else {
        Text(text).textSelection(.enabled)
      }
    }
    // Keep overrides closest to the content; the bundled style sets the same environment keys.
    .textual.codeBlockStyle(MessageCodeBlockStyle())
    .textual.tableStyle(.overflow)
    .textual.structuredTextStyle(.gitHub)
    .textual.imageAttachmentLoader(MessageImageLoader(baseURL: baseURL))
    .textual.textSelection(.enabled)
    .frame(maxWidth: .infinity, alignment: .leading)
    .environment(
      \.openURL,
      OpenURLAction { url in
        guard ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "") else {
          return .discarded
        }
        return .systemAction(url)
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

  private var loader: some AttachmentLoader { .image(relativeTo: baseURL) }

  func attachment(
    for url: URL, text: String, environment: ColorEnvironmentValues
  ) async throws -> some Textual.Attachment {
    let resolved = URL(string: url.absoluteString, relativeTo: baseURL)?.absoluteURL ?? url
    guard ["https", "http"].contains(resolved.scheme?.lowercased() ?? "") else {
      throw URLError(.unsupportedURL)
    }
    return try await loader.attachment(for: resolved, text: text, environment: environment)
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
