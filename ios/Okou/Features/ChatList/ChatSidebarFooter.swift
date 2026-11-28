import SwiftUI

struct ChatSidebarFooter: View {
  let store: WorkspaceStore
  let hasForYou: Bool
  let openForYou: () -> Void
  let newChat: () -> Void
  let rowInset: CGFloat

  private static let activeRingWidth: CGFloat = 1.5

  /// Thumb-reach bar: For you on the left, a new-message capsule, and search on the right.
  var body: some View {
    HStack(spacing: OkouSpace.md) {
      Button(action: openForYou) {
        OkouAvatar(
          size: OkouControl.minimumTarget,
          mood: hasForYou ? .happy : .idle,
          motion: hasForYou ? .animated : .still
        )
        .clipShape(Circle())
        .overlay {
          if hasForYou {
            Circle()
              .strokeBorder(OkouColor.primary, lineWidth: Self.activeRingWidth)
          }
        }
        .modifier(OkouUnreadBadge(isVisible: hasForYou))
      }
      .accessibilityLabel("For you")
      .accessibilityValue(hasForYou ? String(localized: "Unread") : "")
      .accessibilityIdentifier("for-you-sidebar")
      Button {
        newChat()
      } label: {
        Label("New Message", okouSymbol: "square-pen")
          .font(.okou(.body))
          .foregroundStyle(OkouColor.placeholder)
          .lineLimit(1)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, OkouSpace.lg)
          .modifier(OkouGlassControl(shape: .capsule))
      }
      .buttonStyle(.plain)
      .accessibilityLabel("New Message")
      .accessibilityIdentifier("new-chat")
      Button {
        store.search.present()
      } label: {
        OkouToolbarIcon("search")
          .modifier(OkouGlassControl(shape: .circle))
      }
      .accessibilityLabel("Search chats")
      .accessibilityIdentifier("search-chats")
    }
    .buttonStyle(.plain)
    .frame(height: OkouControl.minimumTarget + OkouSpace.md)
    .padding(.horizontal, rowInset)
    .padding(.top, OkouSpace.sm)
  }
}
