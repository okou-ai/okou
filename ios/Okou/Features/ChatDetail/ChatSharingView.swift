import ChatData
import SwiftUI
import UIKit

struct ChatSharingFooter: View {
  @Bindable var sharing: ConversationSharing

  var body: some View {
    VStack(alignment: .leading, spacing: OkouSpace.sm) {
      if let error = sharing.error {
        Text(error).font(.okou(.footnote)).foregroundStyle(OkouColor.destructive)
          .accessibilityIdentifier("chat-sharing-error")
      }
      HStack {
        Text("Only selected messages are included").font(.okou(.caption))
          .foregroundStyle(OkouColor.mutedForeground)
        Spacer()
        Button("Clear") { sharing.clear() }.disabled(sharing.isBusy)
          .font(.okou(.footnote))
      }
      HStack {
        Menu {
          Button("Anyone with the link", okouSymbol: "globe") { sharing.audience = .public }
          Button("People in this workspace", okouSymbol: "users") {
            sharing.audience = .organization
          }
          if sharing.audience == .private {
            Button("Only me", okouSymbol: "lock") { sharing.audience = .private }
          }
        } label: {
          Label(audienceLabel, okouSymbol: audienceSymbol)
            .font(.okou(.callout))
            .frame(minHeight: OkouControl.minimumTarget)
        }
        .disabled(sharing.isBusy)
        .accessibilityIdentifier("chat-sharing-audience")
        Spacer(minLength: OkouSpace.sm)
        Button {
          sharing.create()
        } label: {
          if sharing.isBusy { ProgressView() } else { Text("Create link") }
        }
        .buttonStyle(OkouButtonStyle(isPrimary: true, isCompact: true))
        .disabled(sharing.isBusy || sharing.selectedIDs.isEmpty)
        .accessibilityIdentifier("chat-sharing-create")
      }
    }
    .padding(.horizontal, OkouSpace.lg)
    .padding(.vertical, OkouSpace.sm)
    .background(OkouColor.background)
  }

  private var audienceLabel: String {
    switch sharing.audience {
    case .public: String(localized: "Anyone with the link")
    case .organization: String(localized: "Workspace members")
    case .private: String(localized: "Only me")
    }
  }

  private var audienceSymbol: String {
    switch sharing.audience {
    case .public: "globe"
    case .organization: "users"
    case .private: "lock"
    }
  }
}

struct ChatSharingCreatedView: View {
  @Bindable var sharing: ConversationSharing
  @State private var copied = false

  var body: some View {
    NavigationStack {
      Form {
        Section {
          if let link = sharing.link {
            LabeledContent("Link ready", value: "\(sharing.selectedIDs.count) messages")
            Text(link.absoluteString).font(.okou(.footnote)).textSelection(.enabled)
            Menu {
              Button("Anyone with the link", okouSymbol: "globe") {
                sharing.changeAudience(.public)
              }
              Button("Workspace members", okouSymbol: "users") {
                sharing.changeAudience(.organization)
              }
              Button("Only me", okouSymbol: "lock") { sharing.changeAudience(.private) }
            } label: {
              LabeledContent("Who can view", value: audienceLabel)
            }
            .disabled(sharing.isBusy)
            Button(copied ? "Copied" : "Copy link", okouSymbol: copied ? "check" : "copy") {
              UIPasteboard.general.url = link
              copied = true
            }
            .accessibilityIdentifier("chat-sharing-copy-link")
            ShareLink(item: link) { Label("Share…", okouSymbol: "share") }
              .accessibilityIdentifier("chat-sharing-system-share")
          }
        } footer: {
          Text("Only the selected content is shared. New messages won’t be added.")
        }
        if let error = sharing.error {
          Section { Text(error).foregroundStyle(OkouColor.destructive) }
        }
      }
      .okouGroupedBackground()
      .navigationTitle("Share chat")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { OkouCloseToolbarItem { sharing.showsCreatedLink = false } }
    }
    .okouSheetBackground()
  }

  private var audienceLabel: String {
    switch sharing.visibility?.audience ?? .private {
    case .public: String(localized: "Anyone with the link")
    case .organization: String(localized: "Workspace members")
    case .private: String(localized: "Only me")
    }
  }
}
