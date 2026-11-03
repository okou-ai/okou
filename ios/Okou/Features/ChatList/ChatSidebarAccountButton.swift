import SwiftUI

struct ChatSidebarAccountButton: UIViewRepresentable {
  let sidebar: SidebarInteraction
  let authentication: AuthenticationService
  let notifications: NotificationService
  let webURL: URL
  @Binding var accountError: String?
  @Environment(\.openURL) private var openURL

  func makeUIView(context: Context) -> SidebarMenuButton {
    let button = SidebarMenuButton(sidebar: sidebar)
    var configuration = UIButton.Configuration.glass()
    configuration.cornerStyle = .capsule
    configuration.contentInsets = .zero
    configuration.image = UIImage(systemName: "gearshape")
    configuration.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(pointSize: 21)
    button.configuration = configuration
    button.showsMenuAsPrimaryAction = true
    button.accessibilityIdentifier = "sidebar-account"
    button.accessibilityLabel = String(localized: "Account")
    return button
  }

  func updateUIView(_ button: SidebarMenuButton, context: Context) {
    var actions: [UIMenuElement] = [
      UIAction(title: String(localized: "Open Okou on web")) { _ in openURL(webURL) }
    ]
    if notifications.registrationError != nil {
      actions.append(
        UIAction(
          title: String(localized: "Retry notification setup"),
          image: UIImage(systemName: "bell.badge")
        ) { _ in Task { await notifications.retryRegistration() } })
    }
    actions.append(
      UIAction(
        title: notifications.status == .authorized
          ? String(localized: "Notifications enabled") : String(localized: "Enable notifications"),
        image: UIImage(systemName: "bell")
      ) { _ in Task { await notifications.enable() } })
    actions.append(
      UIAction(
        title: String(localized: "Sign out"),
        image: UIImage(systemName: "rectangle.portrait.and.arrow.right"), attributes: .destructive
      ) { _ in
        Task {
          do {
            try await notifications.signOut(authentication: authentication)
          } catch {
            accountError = error.localizedDescription
          }
        }
      })
    let menu = UIMenu(children: actions)
    button.menu = menu
    button.contextMenuInteraction?.updateVisibleMenu { _ in menu }
    button.tintColor = .label
  }

  static func dismantleUIView(_ button: SidebarMenuButton, coordinator: ()) {
    button.endMenuPresentations()
  }
}

/// Keep the sidebar still until UIKit has returned the lifted menu button to its source.
final class SidebarMenuButton: UIButton {
  private let sidebar: SidebarInteraction
  private var currentPresentation: UUID?
  private var presentations: Set<UUID> = []

  init(sidebar: SidebarInteraction) {
    self.sidebar = sidebar
    super.init(frame: .zero)
  }

  required init?(coder: NSCoder) { nil }

  override func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    willDisplayMenuFor configuration: UIContextMenuConfiguration,
    animator: (any UIContextMenuInteractionAnimating)?
  ) {
    let id = sidebar.beginMenuPresentation()
    currentPresentation = id
    presentations.insert(id)
    super.contextMenuInteraction(interaction, willDisplayMenuFor: configuration, animator: animator)
  }

  override func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction, willEndFor configuration: UIContextMenuConfiguration,
    animator: (any UIContextMenuInteractionAnimating)?
  ) {
    let id = currentPresentation
    currentPresentation = nil
    super.contextMenuInteraction(interaction, willEndFor: configuration, animator: animator)
    guard let id else { return }
    let complete: () -> Void = { [weak self] in self?.endMenuPresentation(id) }
    if let animator {
      animator.addCompletion(complete)
    } else {
      complete()
    }
  }

  func endMenuPresentations() {
    contextMenuInteraction?.dismissMenu()
    for id in presentations { sidebar.endMenuPresentation(id) }
    presentations.removeAll()
    currentPresentation = nil
  }

  private func endMenuPresentation(_ id: UUID) {
    presentations.remove(id)
    sidebar.endMenuPresentation(id)
  }
}
