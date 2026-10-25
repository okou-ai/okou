import SwiftUI

/// UIKit owns the menu's activation, dismissal, and accessibility interactions.
struct ChatThreadMoreButton: View {
  let store: WorkspaceStore
  let threadID: String

  var body: some View {
    if store.list.threads.contains(where: { $0.id == threadID }) {
      ChatThreadMoreControl(store: store, threadID: threadID)
        .frame(width: 44, height: 44)
    }
  }
}

private struct ChatThreadMoreControl: UIViewRepresentable {
  let store: WorkspaceStore
  let threadID: String

  func makeUIView(context: Context) -> UIButton {
    let button = UIButton(type: .system)
    var configuration = UIButton.Configuration.glass()
    configuration.cornerStyle = .capsule
    configuration.contentInsets = .zero
    configuration.image = UIImage(systemName: "ellipsis")
    configuration.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(
      pointSize: 19, weight: .medium)
    button.configuration = configuration
    button.showsMenuAsPrimaryAction = true
    button.accessibilityIdentifier = "chat-thread-more"
    button.accessibilityLabel = "More chat actions"
    return button
  }

  func updateUIView(_ button: UIButton, context: Context) {
    let list = store.list
    guard let thread = list.threads.first(where: { $0.id == threadID }) else { return }
    let pinned = thread.pinnedAt != nil
    let enabled = !store.needsUpgrade && list.canUpdate(threadID)
    let pin = UIAction(
      title: pinned ? "Unpin chat" : "Pin chat",
      image: UIImage(systemName: pinned ? "pin.slash" : "pin"),
      identifier: UIAction.Identifier("chat-pin"),
      attributes: !store.needsUpgrade && list.canPin(threadID) ? [] : .disabled
    ) { _ in
      // Read the current projection, including activations before the next render.
      Task { await list.togglePinned(threadID) }
    }
    let rename = UIAction(
      title: "Rename", image: UIImage(systemName: "pencil"),
      identifier: UIAction.Identifier("chat-rename"),
      attributes: enabled && !list.isSavingRename ? [] : .disabled
    ) { _ in list.beginRename(threadID) }
    var actions: [UIMenuElement] = [pin, rename]
    if list.canMuteChats || thread.isMuted {
      actions.append(
        UIAction(
          title: thread.isMuted ? "Unmute chat" : "Mute chat",
          image: UIImage(systemName: thread.isMuted ? "bell" : "bell.slash"),
          identifier: UIAction.Identifier("chat-mute"),
          attributes: !store.needsUpgrade && list.canMute(threadID) ? [] : .disabled
        ) { _ in
          guard let current = list.threads.first(where: { $0.id == threadID }) else { return }
          Task { await store.setMuted(threadID, muted: !current.isMuted) }
        })
    }
    if list.canArchiveChats {
      let archive = UIAction(
        title: thread.isArchived ? "Unarchive chat" : "Archive chat",
        image: UIImage(systemName: thread.isArchived ? "archivebox.fill" : "archivebox"),
        identifier: UIAction.Identifier("chat-archive"),
        attributes: enabled && (thread.isArchived || !store.isCreating) ? [] : .disabled
      ) { _ in
        guard let current = list.threads.first(where: { $0.id == threadID }) else { return }
        Task {
          await store.setArchived(threadID, archived: !current.isArchived, leaveDetail: true)
        }
      }
      actions.append(UIMenu(options: .displayInline, children: [archive]))
    }
    let menu = UIMenu(children: actions)
    button.menu = menu
    button.contextMenuInteraction?.updateVisibleMenu { _ in menu }
    button.tintColor = .label
    // A pending action only disables the relevant menu items, never the entry.
    button.isEnabled = !store.needsUpgrade
    button.accessibilityValue =
      [
        pinned ? "Pinned" : "Not pinned", thread.isMuted ? "Muted" : nil,
        thread.isArchived ? "Archived" : nil,
      ].compactMap { $0 }.joined(separator: ", ")
  }
}
