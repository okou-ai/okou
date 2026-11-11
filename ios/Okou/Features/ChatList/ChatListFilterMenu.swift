import SwiftUI
import UIKit

/// The shared chat filters, with Chats as the native default label.
extension ChatListFilter {
  var title: String {
    switch self {
    case .recent: String(localized: "Chats")
    case .unread: String(localized: "Unread")
    case .archived: String(localized: "Archived")
    case .muted: String(localized: "Muted")
    }
  }

  var icon: String {
    switch self {
    case .recent: "message-circle"
    case .unread: "mail"
    case .archived: "archive"
    case .muted: "bell-off"
    }
  }
}

/// UIKit owns the lifted button and keeps the sidebar still until it returns to its source.
struct ChatListFilterMenu: UIViewRepresentable {
  let sidebar: SidebarInteraction
  let store: WorkspaceStore
  @Binding var selection: ChatListFilter
  /// Names a new Project; the sidebar owns its name dialog.
  let newProject: () -> Void

  func makeUIView(context: Context) -> SidebarMenuButton {
    let button = SidebarMenuButton(sidebar: sidebar)
    button.showsMenuAsPrimaryAction = true
    button.accessibilityIdentifier = "chat-list-filter"
    button.accessibilityLabel = String(localized: "Chat list")
    return button
  }

  func updateUIView(_ button: SidebarMenuButton, context: Context) {
    let filter = selection
    var configuration = UIButton.Configuration.glass()
    configuration.cornerStyle = .capsule
    configuration.image = OkouIcon.uiImage("list-filter")
    configuration.contentInsets = NSDirectionalEdgeInsets(
      top: 0, leading: filter == .recent ? 0 : OkouSpace.lg,
      bottom: 0, trailing: filter == .recent ? 0 : OkouSpace.lg)
    if filter != .recent {
      configuration.title = filter.title
      configuration.imagePadding = OkouSpace.six
      configuration.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer {
        attributes in
        var attributes = attributes
        attributes.font = OkouTypography.font(
          ofSize: UIFont.preferredFont(forTextStyle: .callout).pointSize, weight: .medium)
        return attributes
      }
    }
    button.configuration = configuration
    button.tintColor = UIColor(OkouColor.foreground)
    button.accessibilityValue = filter.title

    let selection = $selection
    let filters = ChatListFilter.allCases.map { option in
      UIAction(
        title: option.title, image: OkouIcon.uiImage(option.icon),
        state: option == filter ? .on : .off
      ) { _ in selection.wrappedValue = option }
    }
    var groups: [UIMenuElement] = [
      UIMenu(options: [.displayInline, .singleSelection], children: filters)
    ]
    if let agentID = store.selectedAgentID {
      let list = store.list
      let enabled =
        !list.markingAgentRead && list.updatingThreads.isEmpty
        && list.unreadAgentIDs.contains(agentID)
      groups.append(
        UIMenu(
          options: .displayInline,
          children: [
            UIAction(
              title: String(localized: "Mark all as read"), image: OkouIcon.uiImage("check-check"),
              attributes: enabled ? [] : .disabled
            ) { _ in Task { await list.markAgentRead(agentID) } }
          ]))
    }
    let newProject = newProject
    groups.append(
      UIMenu(
        options: .displayInline,
        children: [
          UIAction(
            title: String(localized: "New project"), image: OkouIcon.uiImage("folder-plus"),
            attributes: store.needsUpgrade ? .disabled : []
          ) { _ in newProject() }
        ]))
    let menu = UIMenu(children: groups)
    button.menu = menu
    button.contextMenuInteraction?.updateVisibleMenu { _ in menu }
  }

  func sizeThatFits(_ proposal: ProposedViewSize, uiView: SidebarMenuButton, context: Context)
    -> CGSize?
  {
    CGSize(
      width: max(OkouControl.minimumTarget, uiView.intrinsicContentSize.width),
      height: OkouControl.minimumTarget)
  }

  static func dismantleUIView(_ button: SidebarMenuButton, coordinator: ()) {
    button.endMenuPresentations()
  }
}
