import SwiftUI
import Textual

struct MessageBodyView: View {
  let text: String
  let baseURL: URL

  var body: some View {
    StructuredText(markdown: text, baseURL: baseURL)
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
        })
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
      baseURL: URL(string: "https://app.okou.ai")!
    )
    .padding(20)
  }
}
