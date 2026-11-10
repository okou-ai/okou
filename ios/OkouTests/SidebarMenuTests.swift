import UIKit
import XCTest

@testable import Okou

@MainActor
final class SidebarMenuTests: XCTestCase {
  func testSidebarPanWaitsForTheLiftedMenuButtonToReturn() throws {
    let sidebar = SidebarInteraction()
    sidebar.setOpen(true)
    let pan = UIPanGestureRecognizer()
    sidebar.attachPanGesture(pan)
    defer { sidebar.detachPanGesture(pan) }
    let button = SidebarMenuButton(sidebar: sidebar)
    defer { button.endMenuPresentations() }
    button.menu = UIMenu(children: [UIAction(title: "Chats") { _ in }])
    button.showsMenuAsPrimaryAction = true
    let interaction = try XCTUnwrap(button.contextMenuInteraction)
    let configuration = UIContextMenuConfiguration(
      identifier: nil, previewProvider: nil, actionProvider: nil)
    let animator = MenuDismissalAnimator()

    sidebar.dragChanged(-50)
    button.contextMenuInteraction(interaction, willDisplayMenuFor: configuration, animator: nil)
    XCTAssertFalse(pan.isEnabled)
    XCTAssertNil(sidebar.translation)
    XCTAssertTrue(sidebar.isOpen)

    button.contextMenuInteraction(interaction, willEndFor: configuration, animator: animator)
    XCTAssertFalse(pan.isEnabled)
    // SwiftUI can update the recognizer while UIKit is still returning the lifted button.
    sidebar.attachPanGesture(pan)
    XCTAssertFalse(pan.isEnabled)

    animator.complete()
    XCTAssertTrue(pan.isEnabled)
    sidebar.endDrag(translation: -300, velocity: -600, cancelled: false, sidebarWidth: 390)
    XCTAssertFalse(sidebar.isOpen)
  }

  func testRemovingTheMenuReleasesItsPanLockDespiteALateDismissalCompletion() throws {
    let sidebar = SidebarInteraction()
    let pan = UIPanGestureRecognizer()
    sidebar.attachPanGesture(pan)
    defer { sidebar.detachPanGesture(pan) }
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

    button.contextMenuInteraction(interaction, willDisplayMenuFor: configuration, animator: nil)
    animator.complete()
    XCTAssertFalse(pan.isEnabled)
    button.contextMenuInteraction(interaction, willEndFor: configuration, animator: nil)
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
