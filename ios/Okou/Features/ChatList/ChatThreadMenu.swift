import ChatDomain
import SwiftUI

/// Both native menu presentations use the same actions and current thread projection.
@MainActor
struct ChatThreadMenu {
  enum Action: Hashable {
    case pin, rename, moveToProject, status, mute, markUnread, archive
    case setStatus(String?)
  }

  struct Item: Identifiable {
    let action: Action
    let title: String
    let icon: String?
    let enabled: Bool
    var selected: Bool?
    var separated = false
    var id: Action { action }
  }

  let workspace: WorkspaceStore
  let threadID: String
  let moveToProject: (ChatThread) -> Void

  private var thread: ChatThread? {
    workspace.list.threads.first { $0.id == threadID }
  }

  var title: String { thread?.displayTitle ?? "" }

  var items: [Item] {
    guard let thread else { return [] }
    let list = workspace.list
    let available = !workspace.needsUpgrade
    let enabled = available && list.canUpdate(threadID)
    let pinned = thread.pinnedAt != nil
    var items = [
      Item(
        action: .pin,
        title: pinned ? String(localized: "Unpin chat") : String(localized: "Pin chat"),
        icon: pinned ? "pin-off" : "pin", enabled: available && list.canPin(threadID)),
      Item(
        action: .rename, title: String(localized: "Rename"), icon: "pencil",
        enabled: enabled && !list.isSavingRename),
      Item(
        action: .moveToProject, title: String(localized: "Move to project"),
        icon: "folder-input", enabled: enabled),
      Item(
        action: .status, title: String(localized: "Status"), icon: "circle-check",
        enabled: enabled),
      Item(
        action: .mute,
        title: thread.isMuted ? String(localized: "Unmute chat") : String(localized: "Mute chat"),
        icon: thread.isMuted ? "bell" : "bell-off", enabled: available && list.canMute(threadID)),
    ]
    if !thread.isMuted {
      items.append(
        Item(
          action: .markUnread, title: String(localized: "Mark as unread"), icon: "mail",
          enabled: enabled && !list.markingAgentRead))
    }
    items.append(
      Item(
        action: .archive,
        title: thread.isArchived
          ? String(localized: "Unarchive chat") : String(localized: "Archive chat"),
        icon: thread.isArchived ? "archive-restore" : "archive",
        enabled: enabled && (thread.isArchived || !workspace.isCreating), separated: true))
    return items
  }

  var statusItems: [Item] {
    guard let thread else { return [] }
    let enabled = !workspace.needsUpgrade && workspace.list.canUpdate(threadID)
    let current = thread.titleParts.emoji
    var items = ChatThreadStatus.allCases.map { status in
      Item(
        action: .setStatus(status.rawValue), title: "\(status.rawValue)  \(status.label)",
        icon: nil, enabled: enabled, selected: current == status.rawValue)
    }
    if current != nil {
      items.append(
        Item(
          action: .setStatus(nil), title: String(localized: "Clear status"), icon: "x",
          enabled: enabled, separated: true))
    }
    return items
  }

  func perform(_ action: Action) async {
    // A menu can remain open while a mutation or sync changes the thread.
    guard let thread,
      (items + statusItems).contains(where: { $0.action == action && $0.enabled })
    else { return }
    switch action {
    case .pin: await workspace.list.togglePinned(threadID)
    case .rename: workspace.list.beginRename(threadID)
    case .moveToProject: moveToProject(thread)
    case .status: break
    case .setStatus(let status):
      await workspace.list.rename(thread, title: thread.title(withStatus: status))
    case .mute: await workspace.setMuted(threadID, muted: !thread.isMuted)
    case .markUnread: await workspace.setRead(thread, read: false)
    case .archive:
      await workspace.setArchived(threadID, archived: !thread.isArchived, leaveDetail: true)
    }
  }

  func uiMenu() -> UIMenu {
    UIMenu(title: title, children: uiElements(items))
  }

  private func uiElements(_ items: [Item]) -> [UIMenuElement] {
    items.map { item in
      let element: UIMenuElement
      if item.action == .status {
        element = UIMenu(
          title: item.title, image: item.icon.flatMap(OkouIcon.uiImage),
          children: uiElements(statusItems))
      } else {
        element = UIAction(
          title: item.title, image: item.icon.flatMap(OkouIcon.uiImage),
          attributes: item.enabled ? [] : .disabled,
          state: item.selected == true ? .on : .off
        ) { _ in Task { await perform(item.action) } }
      }
      return item.separated ? UIMenu(options: .displayInline, children: [element]) : element
    }
  }
}

struct ChatThreadMenuContent: View {
  let menu: ChatThreadMenu

  var body: some View {
    Section {
      ForEach(menu.items) { item in
        if item.separated { Divider() }
        if item.action == .status, let icon = item.icon {
          Menu(item.title, image: .init(name: OkouIcon.assetName(for: icon), bundle: .main)) {
            ForEach(menu.statusItems) { status in
              if status.separated { Divider() }
              action(status)
            }
          }
          .disabled(!item.enabled)
        } else {
          action(item)
        }
      }
    } header: {
      Text(verbatim: menu.title)
    }
  }

  @ViewBuilder
  private func action(_ item: ChatThreadMenu.Item) -> some View {
    // Native Text/Image labels preserve UIKit's menu layout and accessibility.
    if let selected = item.selected {
      Toggle(
        item.title,
        isOn: Binding(
          get: { selected }, set: { _ in Task { await menu.perform(item.action) } })
      )
      .disabled(!item.enabled)
    } else if let icon = item.icon {
      Button(item.title, image: .init(name: OkouIcon.assetName(for: icon), bundle: .main)) {
        Task { await menu.perform(item.action) }
      }
      .disabled(!item.enabled)
    } else {
      Button(item.title) { Task { await menu.perform(item.action) } }
        .disabled(!item.enabled)
    }
  }
}
