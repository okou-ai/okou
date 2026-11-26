import CCStateSwiftUI
import ChatDomain
import SwiftUI

/// UIKit owns the menu's activation, dismissal, and accessibility interactions.
struct ChatThreadMoreButton: View {
  let store: WorkspaceStore
  let threadID: String
  @State private var membershipThread: ChatThread?
  /// The confirmed chats, the list status and row mutations, and the workspace's status, kept in
  /// the workspace session's Store.
  @ResolvedValue private var threads: [ChatThread]?
  @ResolvedValue private var status: ThreadListStore.Status?
  @ResolvedValue private var mutations: ThreadListMutations.Activity?
  @ResolvedValue private var shell: WorkspaceStore.Shell?

  init(store: WorkspaceStore, threadID: String) {
    self.store = store
    self.threadID = threadID
    _threads = ResolvedValue(store.list.threadsValue)
    _status = ResolvedValue(store.list.statusValue)
    _mutations = ResolvedValue(store.list.mutationsValue)
    _shell = ResolvedValue(store.shellValue)
  }

  var body: some View {
    if let thread = (threads ?? store.list.threads).first(where: { $0.id == threadID }) {
      // A changed chat, list status, chat write or workspace status rebuilds the menu, since the
      // control receives them as values.
      let workspace = shell ?? store.shell
      ChatThreadMoreControl(
        store: store, thread: thread, status: status ?? store.list.status,
        isUpdating: (mutations ?? store.list.mutations).updatingThreads.contains(thread.id),
        needsUpgrade: workspace.needsUpgrade, isCreating: workspace.isCreating,
        moveToProject: { membershipThread = $0 }
      )
      .frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
      .chatProjectMembershipPicker(workspace: store, thread: $membershipThread)
    }
  }
}

private struct ChatThreadMoreControl: UIViewRepresentable {
  let store: WorkspaceStore
  let thread: ChatThread
  /// The menu's items depend on mark-all-read, rename saving and a write in flight on this chat;
  /// the menu reads them when built.
  let status: ThreadListStore.Status
  let isUpdating: Bool
  /// The entry and the menu's items depend on the update requirement and a new chat being
  /// created; the menu reads them when built.
  let needsUpgrade: Bool
  let isCreating: Bool
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
    let pinned = thread.pinnedAt != nil
    let menu = ChatThreadMenu(
      workspace: store, threadID: thread.id, moveToProject: moveToProject
    ).uiMenu()
    button.menu = menu
    button.contextMenuInteraction?.updateVisibleMenu { _ in menu }
    button.tintColor = UIColor(OkouColor.foreground)
    // A pending action only disables the relevant menu items, never the entry.
    button.isEnabled = !needsUpgrade
    button.accessibilityValue =
      [
        pinned ? String(localized: "Pinned") : String(localized: "Not pinned"),
        thread.isMuted ? String(localized: "Muted") : nil,
        thread.isArchived ? String(localized: "Archived") : nil
      ].compactMap { $0 }.joined(separator: ", ")
  }
}
