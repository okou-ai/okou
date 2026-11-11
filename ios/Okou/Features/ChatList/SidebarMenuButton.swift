import UIKit

/// Menu dismissal finishes after the menu disappears: the lifted button must return first.
final class SidebarMenuButton: UIButton {
  private let sidebar: SidebarInteraction
  private var currentPresentation: UUID?
  private var presentations: Set<UUID> = []

  init(sidebar: SidebarInteraction) {
    self.sidebar = sidebar
    super.init(frame: .zero)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

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
