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
    coordinator.list.rootView = Self.page(list(), in: context.environment)
    coordinator.chat.rootView = Self.page(chat(), in: context.environment)
    navigation.setViewControllers(
      sidebar.isOpen ? [coordinator.list] : [coordinator.list, coordinator.chat], animated: false)
    coordinator.install(on: navigation)
    return navigation
  }

  func updateUIViewController(_ navigation: WorkspaceNavigationController, context: Context) {
    let coordinator = context.coordinator
    coordinator.list.rootView = Self.page(list(), in: context.environment)
    coordinator.chat.rootView = Self.page(chat(), in: context.environment)
    coordinator.requestedSidebarOpen = sidebar.isOpen
    // Reconcile in UIKit's layout lifecycle, outside SwiftUI's update transaction.
    navigation.view.setNeedsLayout()
  }

  /// Each host keeps its own SwiftUI environment and receives only what the app sets above the
  /// navigation. Forwarding the whole environment (`\.self`) also carried SwiftUI's private
  /// state into both hosts: the chat header's scroll edge joined the sidebar's collector, and
  /// the transcript lost its top edge effect whenever the sidebar updated last.
  private static func page(_ content: some View, in environment: EnvironmentValues) -> AnyView {
    AnyView(
      content
        .modifier(OkouContentStyle())
        .environment(\.scenePhase, environment.scenePhase)
        .environment(\.openURL, environment.openURL)
        .environment(\.openChatSource, environment.openChatSource)
        .environment(\.newChatActivation, environment.newChatActivation))
  }

  static func dismantleUIViewController(
    _ navigation: WorkspaceNavigationController, coordinator: Coordinator
  ) {
    navigation.applySelection = nil
    navigation.delegate = nil
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

    init(sidebar: SidebarInteraction) {
      self.sidebar = sidebar
      requestedSidebarOpen = sidebar.isOpen
    }

    func install(on navigation: WorkspaceNavigationController) {
      self.navigation = navigation
      navigation.loadViewIfNeeded()
      // Keep native return gestures available while the navigation bar is hidden.
      navigation.interactivePopGestureRecognizer?.delegate = nil
      navigation.interactiveContentPopGestureRecognizer?.delegate = nil
      navigation.delegate = self
      navigation.applySelection = { [weak self] in self?.applySelection() }
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
