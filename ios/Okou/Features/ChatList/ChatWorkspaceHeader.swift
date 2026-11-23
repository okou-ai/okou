import CCStateSwiftUI
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
    StoreProvider(store.sidebar.stateStore) {
      ChatWorkspaceHeaderContent(store: store, height: height, openSidebar: openSidebar)
        .id(ObjectIdentifier(store))
    }
  }
}

private struct ChatWorkspaceHeaderContent: View {
  let store: WorkspaceStore
  let height: CGFloat
  let openSidebar: () -> Void
  @LoadableValue private var unreadThreads: Loadable<Bool>

  init(store: WorkspaceStore, height: CGFloat, openSidebar: @escaping () -> Void) {
    self.store = store
    self.height = height
    self.openSidebar = openSidebar
    _unreadThreads = LoadableValue(store.sidebar.hasUnreadThreads)
  }

  private var hasUnread: Bool {
    if case .hasData(true) = unreadThreads { return true }
    return false
  }

  var body: some View {
    HStack(spacing: OkouSpace.sm) {
      if let sharing = store.selectedConversation?.sharing, sharing.isSelecting {
        Text("\(sharing.selectedCount) selected").font(.okou(.headline))
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
