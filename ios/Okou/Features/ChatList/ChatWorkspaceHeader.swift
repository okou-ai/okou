import SwiftUI

struct ChatWorkspaceHeader: ViewModifier {
  let store: WorkspaceStore
  let openSidebar: () -> Void

  func body(content: Content) -> some View {
    content
      .navigationTitle(
        store.list.threads.first(where: { $0.id == store.selectedThreadID })?.displayTitle
          ?? store.currentAgentName
      )
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button("Open sidebar", systemImage: "line.3.horizontal", action: openSidebar)
            .accessibilityIdentifier("open-sidebar")
        }
        if let thread = store.list.threads.first(where: { $0.id == store.selectedThreadID }) {
          ToolbarItem(placement: .topBarTrailing) {
            ChatThreadMoreButton(store: store, threadID: thread.id)
          }
        }
      }
  }
}
