import SwiftUI

/// UIKit owns the menu's activation, dismissal, and accessibility interactions.
struct ChatThreadMoreButton: View {
  let store: WorkspaceStore
  let threadID: String

  var body: some View {
    if store.list.threads.contains(where: { $0.id == threadID }) {
      ChatThreadMoreControl(store: store, threadID: threadID)
        .frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
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
    configuration.image = OkouIcon.uiImage("ellipsis")
    button.configuration = configuration
    button.showsMenuAsPrimaryAction = true
    button.accessibilityIdentifier = "chat-thread-more"
    button.accessibilityLabel = String(localized: "More chat actions")
    return button
  }

  func updateUIView(_ button: UIButton, context: Context) {
    let list = store.list
    guard let thread = list.threads.first(where: { $0.id == threadID }) else { return }
    let pinned = thread.pinnedAt != nil
    let enabled = !store.needsUpgrade && list.canUpdate(threadID)
    let pin = UIAction(
      title: pinned ? String(localized: "Unpin chat") : String(localized: "Pin chat"),
      image: OkouIcon.uiImage(pinned ? "pin-off" : "pin"),
      identifier: UIAction.Identifier("chat-pin"),
      attributes: !store.needsUpgrade && list.canPin(threadID) ? [] : .disabled
    ) { _ in
      // Read the current projection, including activations before the next render.
      Task { await list.togglePinned(threadID) }
    }
    let rename = UIAction(
      title: String(localized: "Rename"), image: OkouIcon.uiImage("pencil"),
      identifier: UIAction.Identifier("chat-rename"),
      attributes: enabled && !list.isSavingRename ? [] : .disabled
    ) { _ in list.beginRename(threadID) }
    // The same status markers the web offers; they live in the title so both clients agree.
    let currentStatus = thread.titleParts.emoji
    var statusActions: [UIMenuElement] = ChatThreadStatus.allCases.map { status in
      UIAction(
        title: "\(status.rawValue)  \(status.label)",
        identifier: UIAction.Identifier("chat-status-\(status.label)"),
        attributes: enabled ? [] : .disabled,
        state: currentStatus == status.rawValue ? .on : .off
      ) { _ in
        guard let current = list.threads.first(where: { $0.id == threadID }) else { return }
        Task { await list.rename(current, title: current.title(withStatus: status.rawValue)) }
      }
    }
    if currentStatus != nil {
      statusActions.append(
        UIMenu(
          options: .displayInline,
          children: [
            UIAction(
              title: String(localized: "Clear status"), image: OkouIcon.uiImage("x"),
              identifier: UIAction.Identifier("chat-status-clear"),
              attributes: enabled ? [] : .disabled
            ) { _ in
              guard let current = list.threads.first(where: { $0.id == threadID }) else { return }
              Task { await list.rename(current, title: current.title(withStatus: nil)) }
            }
          ]))
    }
    let status = UIMenu(
      title: String(localized: "Status"), image: OkouIcon.uiImage("circle-check"),
      children: statusActions)
    var actions: [UIMenuElement] = [pin, rename, status]
    actions.append(
      UIAction(
        title: thread.isMuted ? String(localized: "Unmute chat") : String(localized: "Mute chat"),
        image: OkouIcon.uiImage(thread.isMuted ? "bell" : "bell-off"),
        identifier: UIAction.Identifier("chat-mute"),
        attributes: !store.needsUpgrade && list.canMute(threadID) ? [] : .disabled
      ) { _ in
        guard let current = list.threads.first(where: { $0.id == threadID }) else { return }
        Task { await store.setMuted(threadID, muted: !current.isMuted) }
      })
    let archive = UIAction(
      title: thread.isArchived
        ? String(localized: "Unarchive chat") : String(localized: "Archive chat"),
      image: OkouIcon.uiImage(thread.isArchived ? "archive-restore" : "archive"),
      identifier: UIAction.Identifier("chat-archive"),
      attributes: enabled && (thread.isArchived || !store.isCreating) ? [] : .disabled
    ) { _ in
      guard let current = list.threads.first(where: { $0.id == threadID }) else { return }
      Task {
        await store.setArchived(threadID, archived: !current.isArchived, leaveDetail: true)
      }
    }
    actions.append(UIMenu(options: .displayInline, children: [archive]))
    let menu = UIMenu(title: thread.displayTitle, children: actions)
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
