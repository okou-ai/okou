import SwiftUI
import UIKit

/// UIKit owns the stack, interactive pop and transitions; each page keeps its own chrome.
struct WorkspaceNavigation<Sidebar: View, Chat: View>: UIViewControllerRepresentable {
  let sidebar: SidebarInteraction
  @ViewBuilder let list: () -> Sidebar
  @ViewBuilder let chat: () -> Chat

  func makeCoordinator() -> Coordinator { Coordinator(sidebar: sidebar) }

  func makeUIViewController(context: Context) -> WorkspaceNavigationController {
    let coordinator = context.coordinator
    let navigation = WorkspaceNavigationController()
    navigation.setNavigationBarHidden(true, animated: false)
    coordinator.list.rootView = AnyView(list().environment(\.self, context.environment))
    coordinator.chat.rootView = AnyView(chat().environment(\.self, context.environment))
    navigation.setViewControllers(
      sidebar.isOpen ? [coordinator.list] : [coordinator.list, coordinator.chat], animated: false)
    coordinator.install(on: navigation)
    return navigation
  }

  func updateUIViewController(_ navigation: WorkspaceNavigationController, context: Context) {
    let coordinator = context.coordinator
    coordinator.list.rootView = AnyView(list().environment(\.self, context.environment))
    coordinator.chat.rootView = AnyView(chat().environment(\.self, context.environment))
    coordinator.requestedSidebarOpen = sidebar.isOpen
    // Reconcile in UIKit's layout lifecycle, outside SwiftUI's update transaction.
    navigation.view.setNeedsLayout()
  }

  static func dismantleUIViewController(
    _ navigation: WorkspaceNavigationController, coordinator: Coordinator
  ) {
    navigation.applySelection = nil
    navigation.delegate = nil
    coordinator.sidebar.setNavigationGestures([])
    coordinator.sidebar.setTransitioning(false)
  }

  @MainActor
  final class Coordinator: NSObject, UINavigationControllerDelegate, UIGestureRecognizerDelegate {
    let sidebar: SidebarInteraction
    // Retain both hosts across a pop so drafts, list position and transcript state survive.
    let list = UIHostingController(rootView: AnyView(EmptyView()))
    let chat = UIHostingController(rootView: AnyView(EmptyView()))
    var requestedSidebarOpen: Bool
    private weak var navigation: UINavigationController?
    private var transitionTarget: Bool?

    init(sidebar: SidebarInteraction) {
      self.sidebar = sidebar
      requestedSidebarOpen = sidebar.isOpen
    }

    func install(on navigation: WorkspaceNavigationController) {
      self.navigation = navigation
      navigation.delegate = self
      navigation.applySelection = { [weak self] in self?.applySelection() }
      let forward = UISwipeGestureRecognizer(target: self, action: #selector(returnToChat))
      forward.direction = .left
      forward.delegate = self
      list.view.addGestureRecognizer(forward)
      let gestures = [
        navigation.interactivePopGestureRecognizer,
        navigation.interactiveContentPopGestureRecognizer,
        forward,
      ].compactMap { $0 }
      for gesture in gestures { gesture.delegate = self }
      sidebar.setNavigationGestures(gestures)
    }

    private func applySelection() {
      guard let navigation, transitionTarget == nil,
        navigation.transitionCoordinator == nil,
        (navigation.topViewController === list) != requestedSidebarOpen
      else { return }
      navigation.view.endEditing(true)
      if requestedSidebarOpen {
        navigation.popToRootViewController(animated: true)
      } else {
        navigation.pushViewController(chat, animated: true)
      }
    }

    @objc private func returnToChat() {
      guard sidebar.allowsDragging else { return }
      requestedSidebarOpen = false
      sidebar.setOpen(false)
      applySelection()
    }

    func navigationController(
      _ navigationController: UINavigationController, willShow viewController: UIViewController,
      animated: Bool
    ) {
      let showsSidebar = viewController === list
      transitionTarget = showsSidebar
      sidebar.setTransitioning(true)
      if navigationController.transitionCoordinator?.isInteractive == true {
        requestedSidebarOpen = showsSidebar
        sidebar.setOpen(showsSidebar)
        navigationController.view.endEditing(true)
      }
    }

    func navigationController(
      _ navigationController: UINavigationController, didShow viewController: UIViewController,
      animated: Bool
    ) {
      let showsSidebar = viewController === list
      // A notification or deep link can request another page while a transition is running.
      if requestedSidebarOpen == transitionTarget {
        requestedSidebarOpen = showsSidebar
        sidebar.setOpen(showsSidebar)
      }
      transitionTarget = nil
      sidebar.setTransitioning(false)
      navigationController.view.setNeedsLayout()
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
      guard let navigation, sidebar.allowsDragging, transitionTarget == nil,
        navigation.transitionCoordinator == nil
      else { return false }
      if gestureRecognizer is UISwipeGestureRecognizer {
        return navigation.topViewController === list
      }
      // A hidden navigation bar has no Back item. The stack still owns the native pop.
      return navigation.viewControllers.count > 1
    }

    func gestureRecognizer(
      _ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch
    ) -> Bool {
      guard gestureRecognizer === navigation?.interactiveContentPopGestureRecognizer else {
        return true
      }
      // Horizontal content keeps its gesture; the system's screen-edge pop remains available.
      var view = touch.view
      while let current = view {
        if let scroll = current as? UIScrollView,
          scroll.contentSize.width > scroll.bounds.width + 1
        {
          return false
        }
        view = current.superview
      }
      return true
    }
  }
}

final class WorkspaceNavigationController: UINavigationController {
  var applySelection: (() -> Void)?

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    applySelection?()
  }
}
