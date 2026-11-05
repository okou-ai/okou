import ChatDomain
import SwiftUI

/// Two glass controls over the transcript and no title: the selected row in the sidebar says
/// which chat this is, and the transcript's soft edge blurs under the bar. The agent's
/// profile is in the "…" menu (and on the home greeting's avatar).
struct ChatWorkspaceHeader: View {
  let store: WorkspaceStore
  let height: CGFloat
  let openSidebar: () -> Void
  let openAgent: () -> Void

  var body: some View {
    HStack {
      Button(action: openSidebar) {
        OkouToolbarIcon("menu").modifier(OkouGlassControl(shape: .circle))
      }
      .accessibilityLabel("Open sidebar")
      .accessibilityIdentifier("open-sidebar")
      Spacer()
      if let threadID = store.selectedThreadID {
        ChatThreadMoreButton(store: store, threadID: threadID, openAgent: openAgent)
      }
    }
    .buttonStyle(.plain)
    .padding(.horizontal, OkouSpace.lg)
    .frame(height: height)
  }
}
