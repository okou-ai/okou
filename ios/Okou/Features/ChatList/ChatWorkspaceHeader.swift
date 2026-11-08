import ChatDomain
import SwiftUI

/// Glass controls over the transcript and no title: the menu, then the chat's model as a
/// capsule (as Kimi and ChatGPT place it), and the chat's "…" menu on the right. The selected
/// row in the sidebar says which chat this is, and the transcript's soft edge blurs under the
/// bar.
struct ChatWorkspaceHeader: View {
  let store: WorkspaceStore
  let height: CGFloat
  let openSidebar: () -> Void
  /// The model of the chat on screen, or of the next new chat on the home screen.
  var modelSelection: ChatModelSelectionStore? = nil

  var body: some View {
    let hasUnread = store.list.hasUnreadThreads
    HStack(spacing: OkouSpace.sm) {
      Button(action: openSidebar) {
        OkouToolbarIcon("menu")
          .modifier(OkouGlassControl(shape: .circle))
          .modifier(OkouUnreadBadge(isVisible: hasUnread))
      }
      .accessibilityLabel("Open sidebar")
      .accessibilityValue(hasUnread ? Text("Unread") : Text(verbatim: ""))
      .accessibilityIdentifier("open-sidebar")
      if let modelSelection {
        ChatModelPickerButton(selection: modelSelection)
          .disabled(store.needsUpgrade)
      }
      Spacer(minLength: OkouSpace.sm)
      if let threadID = store.selectedThreadID {
        ChatThreadMoreButton(store: store, threadID: threadID)
      }
    }
    .buttonStyle(.plain)
    .padding(.horizontal, OkouSpace.lg)
    .frame(height: height)
  }
}
