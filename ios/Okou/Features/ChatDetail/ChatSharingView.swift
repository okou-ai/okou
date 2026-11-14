import ChatData
import ChatDomain
import SwiftUI
import UIKit

/// Selection is observed inside the hosted row, independently of its measured content.
struct ChatSharingRow<Content: View>: View {
  let group: ChatShareGroup
  let sharing: ConversationSharing
  @ViewBuilder let content: () -> Content

  var body: some View {
    let ids = Set(group.eventIDs)
    let selectedIDs = sharing.selectedIDs(in: group)
    let selected = ids.isSubset(of: selectedIDs)
    let partial = !selected && !ids.isDisjoint(with: selectedIDs)
    Button {
      sharing.toggle(group)
    } label: {
      content()
        // In selection mode, links, cards, and text forward taps to the containing button.
        .allowsHitTesting(false)
        .overlay(alignment: .topLeading) {
          OkouSelectionIndicator(isSelected: selected, isIndeterminate: partial)
            .frame(width: OkouAvatarSize.message, height: OkouAvatarSize.message)
        }
        .frame(maxWidth: .infinity, minHeight: OkouControl.minimumTarget, alignment: .leading)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(sharing.isBusy || sharing.visibility != nil)
    .background {
      RoundedRectangle(cornerRadius: OkouRadius.chat)
        .fill(selected ? OkouColor.stateSelected : .clear)
        .padding(-OkouSpace.sm)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(group.messages.map(\.copyText).joined(separator: "\n"))
    .accessibilityHint(group.messages.first?.role == .user ? "Select question" : "Select answer")
    .accessibilityValue(partial ? "Partially selected" : selected ? "Selected" : "Not selected")
    .accessibilityAddTraits(selected ? .isSelected : [])
    .accessibilityIdentifier("chat-sharing-select-\(group.id)")
  }
}

struct ChatSharingFooter: View {
  @Bindable var sharing: ConversationSharing
  @State private var copied = false

  var body: some View {
    VStack(alignment: .leading, spacing: OkouSpace.sm) {
      if let error = sharing.error {
        Text(error).font(.okou(.footnote)).foregroundStyle(OkouColor.destructive)
          .accessibilityIdentifier("chat-sharing-error")
      }
      HStack {
        if copied {
          Label("Link copied", okouSymbol: "check")
            .font(.okou(.caption)).foregroundStyle(OkouColor.mutedForeground)
            .accessibilityIdentifier("chat-sharing-link-copied")
        } else {
          Text("Only selected messages are included").font(.okou(.caption))
            .foregroundStyle(OkouColor.mutedForeground)
        }
        Spacer()
        if sharing.visibility == nil {
          Button {
            sharing.clear()
          } label: {
            Text("Clear").font(.okou(.footnote))
              .frame(minWidth: OkouControl.minimumTarget, minHeight: OkouControl.minimumTarget)
              .contentShape(Rectangle())
          }
          .disabled(sharing.isBusy)
        }
      }
      .frame(minHeight: OkouControl.minimumTarget)
      HStack {
        if sharing.visibility != nil {
          Button {
            sharing.showsCreatedLink = true
          } label: {
            Text("Manage link").font(.okou(.callout))
              .frame(minHeight: OkouControl.minimumTarget)
              .contentShape(Rectangle())
          }
          Spacer()
          if let link = sharing.link {
            Button {
              UIPasteboard.general.url = link
              copied = true
            } label: {
              Label("Copy link", okouSymbol: "copy")
                .frame(minHeight: OkouControl.minimumTarget)
                .contentShape(Rectangle())
            }
            ShareLink(item: link) {
              Label("Share…", okouSymbol: "share")
                .frame(minHeight: OkouControl.minimumTarget)
                .contentShape(Rectangle())
            }
          }
        } else {
          Menu {
            Button("Anyone with the link", okouSymbol: "globe") { sharing.audience = .public }
            Button("People in this workspace", okouSymbol: "users") {
              sharing.audience = .organization
            }
            Button("Only me", okouSymbol: "lock") { sharing.audience = .private }
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
            HStack(spacing: OkouSpace.sm) {
              if sharing.isBusy { ProgressView() }
              Text(sharing.isBusy ? "Creating link…" : "Share")
            }
          }
          .buttonStyle(OkouButtonStyle(isPrimary: true, isCompact: true))
          .disabled(sharing.isBusy || sharing.selectedIDs.isEmpty)
          .accessibilityIdentifier("chat-sharing-create")
        }
      }
    }
    .padding(.horizontal, OkouSpace.lg)
    .padding(.vertical, OkouSpace.sm)
    .background(OkouColor.background)
    .onChange(of: sharing.link) { _, link in
      if let link {
        UIPasteboard.general.url = link
        copied = true
      } else {
        copied = false
      }
    }
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
            LabeledContent("Link ready", value: "\(sharing.selectedCount) selected")
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
