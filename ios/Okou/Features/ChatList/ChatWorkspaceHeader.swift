import ChatDomain
import SwiftUI

/// Glass controls over the transcript and no title: the menu on the left and the chat's "…"
/// menu on the right; the chat's model is in the open composer. The selected row in the
/// sidebar says which chat this is, and the transcript's soft edge blurs under the bar.
struct ChatWorkspaceHeader: View {
  let store: WorkspaceStore
  let height: CGFloat
  let openSidebar: () -> Void

  var body: some View {
    let hasUnread = store.list.hasUnreadThreads
    HStack(spacing: OkouSpace.sm) {
      if let sharing = store.selectedConversation?.sharing, sharing.isSelecting {
        Text("\(sharing.selectedIDs.count) selected").font(.okou(.headline))
          .accessibilityIdentifier("chat-sharing-count")
        Spacer()
        Button {
          sharing.cancel()
        } label: {
          OkouToolbarIcon("x").modifier(OkouGlassControl(shape: .circle))
        }
        .accessibilityLabel("Cancel selection")
        .accessibilityIdentifier("chat-sharing-cancel")
      } else {
        Button(action: openSidebar) {
          OkouToolbarIcon("menu")
            .modifier(OkouUnreadBadge(isVisible: hasUnread))
            .modifier(OkouGlassControl(shape: .circle))
        }
        .accessibilityLabel("Open sidebar")
        .accessibilityValue(hasUnread ? Text("Unread") : Text(verbatim: ""))
        .accessibilityIdentifier("open-sidebar")
        Spacer(minLength: OkouSpace.sm)
        if let threadID = store.selectedThreadID {
          ChatThreadMoreButton(store: store, threadID: threadID)
        }
      }
    }
    .buttonStyle(.plain)
    .padding(.horizontal, OkouSpace.lg)
    .frame(height: height)
  }
}
