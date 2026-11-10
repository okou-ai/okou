import ChatDomain
import SwiftUI

/// UIKit owns the menu's activation, dismissal, and accessibility interactions.
struct ChatThreadMoreButton: View {
  let store: WorkspaceStore
  let threadID: String
  @State private var membershipThread: ChatThread?

  var body: some View {
    if store.list.threads.contains(where: { $0.id == threadID }) {
      ChatThreadMoreControl(
        store: store, threadID: threadID, moveToProject: { membershipThread = $0 }
      )
      .frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
      .chatProjectMembershipPicker(workspace: store, thread: $membershipThread)
    }
  }
}

private struct ChatThreadMoreControl: UIViewRepresentable {
  let store: WorkspaceStore
  let threadID: String
  let moveToProject: (ChatThread) -> Void

  func makeUIView(context: Context) -> UIButton {
    let button = UIButton(type: .system)
    var configuration = UIButton.Configuration.glass()
    configuration.cornerStyle = .capsule
    configuration.contentInsets = .zero
    configuration.image = OkouIcon.uiImage("ellipsis")
    button.configuration = configuration
    button.showsMenuAsPrimaryAction = true
    button.preferredMenuElementOrder = .fixed
    button.accessibilityIdentifier = "chat-thread-more"
    button.accessibilityLabel = String(localized: "More chat actions")
    return button
  }

  func updateUIView(_ button: UIButton, context: Context) {
    let list = store.list
    guard let thread = list.threads.first(where: { $0.id == threadID }) else { return }
    let pinned = thread.pinnedAt != nil
    let menu = ChatThreadMenu(
      workspace: store, threadID: threadID, moveToProject: moveToProject
    ).uiMenu()
    button.menu = menu
    button.contextMenuInteraction?.updateVisibleMenu { _ in menu }
    button.tintColor = UIColor(OkouColor.foreground)
    // A pending action only disables the relevant menu items, never the entry.
    button.isEnabled = !store.needsUpgrade
    button.accessibilityValue =
      [
        pinned ? String(localized: "Pinned") : String(localized: "Not pinned"),
        thread.isMuted ? String(localized: "Muted") : nil,
        thread.isArchived ? String(localized: "Archived") : nil,
      ].compactMap { $0 }.joined(separator: ", ")
  }
}
