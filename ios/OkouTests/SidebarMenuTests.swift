import UIKit
import XCTest

@testable import Okou

@MainActor
final class SidebarMenuTests: XCTestCase {
  func testNavigationGestureWaitsForTheLiftedMenuButtonToReturn() throws {
    let sidebar = SidebarInteraction()
    sidebar.setOpen(true)
    let pan = UIPanGestureRecognizer()
    sidebar.setNavigationGestures([pan])
    defer { sidebar.setNavigationGestures([]) }
    let button = SidebarMenuButton(sidebar: sidebar)
    defer { button.endMenuPresentations() }
    button.menu = UIMenu(children: [UIAction(title: "Chats") { _ in }])
    button.showsMenuAsPrimaryAction = true
    let interaction = try XCTUnwrap(button.contextMenuInteraction)
    let configuration = UIContextMenuConfiguration(
      identifier: nil, previewProvider: nil, actionProvider: nil)
    let animator = MenuDismissalAnimator()

    button.contextMenuInteraction(interaction, willDisplayMenuFor: configuration, animator: nil)
    XCTAssertFalse(pan.isEnabled)
    XCTAssertTrue(sidebar.isOpen)

    button.contextMenuInteraction(interaction, willEndFor: configuration, animator: animator)
    XCTAssertFalse(pan.isEnabled)
    // SwiftUI can update the recognizer while UIKit is still returning the lifted button.
    sidebar.setNavigationGestures([pan])
    XCTAssertFalse(pan.isEnabled)

    animator.complete()
    XCTAssertTrue(pan.isEnabled)
  }

  func testRemovingTheMenuReleasesItsPanLockDespiteALateDismissalCompletion() throws {
    let sidebar = SidebarInteraction()
    let pan = UIPanGestureRecognizer()
    sidebar.setNavigationGestures([pan])
    defer { sidebar.setNavigationGestures([]) }
    let button = SidebarMenuButton(sidebar: sidebar)
    defer { button.endMenuPresentations() }
    button.menu = UIMenu(children: [UIAction(title: "Chats") { _ in }])
    button.showsMenuAsPrimaryAction = true
    let interaction = try XCTUnwrap(button.contextMenuInteraction)
    let configuration = UIContextMenuConfiguration(
      identifier: nil, previewProvider: nil, actionProvider: nil)
    let animator = MenuDismissalAnimator()
    button.contextMenuInteraction(interaction, willDisplayMenuFor: configuration, animator: nil)
    button.contextMenuInteraction(interaction, willEndFor: configuration, animator: animator)

    ChatListFilterMenu.dismantleUIView(button, coordinator: ())
    XCTAssertTrue(pan.isEnabled)

    let replacement = SidebarMenuButton(sidebar: sidebar)
    defer { replacement.endMenuPresentations() }
    replacement.menu = UIMenu(children: [UIAction(title: "Chats") { _ in }])
    replacement.showsMenuAsPrimaryAction = true
    let replacementInteraction = try XCTUnwrap(replacement.contextMenuInteraction)
    replacement.contextMenuInteraction(
      replacementInteraction, willDisplayMenuFor: configuration, animator: nil)
    animator.complete()
    XCTAssertFalse(pan.isEnabled)
    replacement.contextMenuInteraction(
      replacementInteraction, willEndFor: configuration, animator: nil)
    XCTAssertTrue(pan.isEnabled)
  }
}

/// UIKit's animation boundary is external; tests release it without waiting on display frames.
@MainActor
private final class MenuDismissalAnimator: NSObject, UIContextMenuInteractionAnimating {
  var previewViewController: UIViewController? { nil }
  private var completions: [() -> Void] = []

  func addAnimations(_ animations: @escaping () -> Void) {
    animations()
  }

  func addCompletion(_ completion: @escaping () -> Void) {
    completions.append(completion)
  }

  func complete() {
    let pending = completions
    completions.removeAll()
    for completion in pending { completion() }
  }
}
