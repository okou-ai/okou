import ChatData
import SwiftUI
import UIKit

/// Quiet actions under the last answer of a turn, as the web draws them: copy and share
/// (`Copy`, `Share2`), 16 pt glyphs in the web's muted-foreground at 60 % (gray-600), 32 pt
/// apart, the first glyph on the answer's text edge. Opening the chat on the web lives in the
/// header's "…" menu, as on the web, where this row has no such action.
struct MessageActionBar: View {
  let text: String
  let chatURL: URL
  /// Creates a share link for this answer and the request that led to it.
  var shareLink: ((ChatShareAudience) async throws -> URL)? = nil
  @State private var copied = false
  @State private var copyCount = 0
  @State private var sharing = false
  @State private var shareError: String?

  var body: some View {
    HStack(spacing: 0) {
      Button {
        UIPasteboard.general.string = text
        copyCount += 1
        copied = true
        Task {
          try? await Task.sleep(for: OkouMotion.confirmation)
          copied = false
        }
      } label: {
        icon(copied ? "check" : "copy")
      }
      .accessibilityLabel(copied ? "Copied" : "Copy response")
      .accessibilityIdentifier("message-copy")

      Menu {
        if let shareLink {
          Button("Copy link for the workspace", okouSymbol: "link") {
            copyLink(shareLink, audience: .organization)
          }
          Button("Copy public link", okouSymbol: "globe") {
            copyLink(shareLink, audience: .public)
          }
        }
        ShareLink(item: text) {
          Label("Share text…", okouSymbol: "share")
        }
      } label: {
        if sharing {
          ProgressView().controlSize(.small)
            .frame(width: OkouControl.messageActionPitch, height: OkouControl.inlineActionHeight)
        } else {
          icon("share-2")
        }
      }
      .disabled(sharing)
      .accessibilityLabel("Share response")
      .accessibilityIdentifier("message-share")
    }
    .buttonStyle(.plain)
    .foregroundStyle(OkouColor.gray600)
    // The first glyph lines up with the answer text instead of its touch target.
    .padding(.leading, -(OkouControl.messageActionPitch - OkouIconSize.inline) / 2)
    .sensoryFeedback(.success, trigger: copyCount)
    .alert(
      "Couldn't create a link",
      isPresented: Binding(get: { shareError != nil }, set: { if !$0 { shareError = nil } })
    ) {
      Button("OK") { shareError = nil }
    } message: {
      Text(shareError ?? "")
    }
  }

  private func copyLink(
    _ make: @escaping (ChatShareAudience) async throws -> URL, audience: ChatShareAudience
  ) {
    sharing = true
    Task {
      defer { sharing = false }
      do {
        UIPasteboard.general.url = try await make(audience)
        copyCount += 1
        copied = true
        try? await Task.sleep(for: OkouMotion.confirmation)
        copied = false
      } catch {
        shareError = error.localizedDescription
      }
    }
  }

  private func icon(_ name: String) -> some View {
    OkouIcon(name, size: OkouIconSize.inline)
      .frame(width: OkouControl.messageActionPitch, height: OkouControl.inlineActionHeight)
      .contentShape(Rectangle())
  }
}
