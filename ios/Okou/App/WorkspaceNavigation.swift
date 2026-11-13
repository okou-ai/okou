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
    coordinator.uninstallPopGestures()
    coordinator.sidebar.setTransitioning(false)
  }

  @MainActor
  final class Coordinator: NSObject, UINavigationControllerDelegate {
    let sidebar: SidebarInteraction
    // Retain both hosts across a pop so drafts, list position and transcript state survive.
    let list = UIHostingController(rootView: AnyView(EmptyView()))
    let chat = UIHostingController(rootView: AnyView(EmptyView()))
    var requestedSidebarOpen: Bool
    private weak var navigation: UINavigationController?
    private var transitionTarget: Bool?
    private var popGestures: [WorkspacePopGestureDelegate] = []

    init(sidebar: SidebarInteraction) {
      self.sidebar = sidebar
      requestedSidebarOpen = sidebar.isOpen
    }

    func install(on navigation: WorkspaceNavigationController) {
      self.navigation = navigation
      navigation.loadViewIfNeeded()
      popGestures = [
        navigation.interactivePopGestureRecognizer,
        navigation.interactiveContentPopGestureRecognizer,
      ].compactMap { $0 }.map {
        WorkspacePopGestureDelegate(navigation: navigation, gestureRecognizer: $0)
      }
      navigation.delegate = self
      navigation.applySelection = { [weak self] in self?.applySelection() }
    }

    func uninstallPopGestures() {
      for popGesture in popGestures {
        popGesture.uninstall()
      }
      popGestures.removeAll()
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

    func navigationController(
      _ navigationController: UINavigationController, willShow viewController: UIViewController,
      animated: Bool
    ) {
      let showsSidebar = viewController === list
      transitionTarget = showsSidebar
      sidebar.setTransitioning(true)
      // A native pop (including accessibility return) starts outside the SwiftUI selection.
      if requestedSidebarOpen != showsSidebar {
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
  }
}

final class WorkspaceNavigationController: UINavigationController {
  var applySelection: (() -> Void)?

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    applySelection?()
  }
}
