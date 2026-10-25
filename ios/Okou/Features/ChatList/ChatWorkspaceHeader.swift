import SwiftUI

struct ChatWorkspaceHeader: View {
  let store: WorkspaceStore
  let height: CGFloat
  let openSidebar: () -> Void

  var body: some View {
    ZStack {
      Text(
        store.list.threads.first(where: { $0.id == store.selectedThreadID })?.displayTitle
          ?? store.currentAgentName
      )
      .font(.system(size: 17, weight: .semibold))
      .lineLimit(1)
      .padding(.horizontal, 66)
      HStack {
        Button(action: openSidebar) {
          Image(systemName: "line.3.horizontal")
            .font(.system(size: 19, weight: .medium))
            .frame(width: 32, height: 32)
        }
        .buttonStyle(.glass)
        .buttonBorderShape(.circle)
        .accessibilityLabel("Open sidebar")
        .accessibilityIdentifier("open-sidebar")
        Spacer()
        if let thread = store.list.threads.first(where: { $0.id == store.selectedThreadID }) {
          ChatThreadMoreButton(store: store, threadID: thread.id)
        }
      }
    }
    .buttonStyle(.plain)
    .padding(.horizontal, 16)
    .frame(height: height)
  }
}
