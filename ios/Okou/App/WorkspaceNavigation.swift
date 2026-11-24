import SwiftUI
import UIKit

/// Both pages keep their own chrome and share one UIKit navigation stack.
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
    coordinator.chat.rootView = AnyView(
      chat().environment(\.self, context.environment)
        .environment(\.workspaceChatPresentation, coordinator.presentation))
    navigation.setViewControllers(
      sidebar.isOpen ? [coordinator.list] : [coordinator.list, coordinator.chat], animated: false)
    coordinator.install(on: navigation)
    return navigation
  }

  func updateUIViewController(_ navigation: WorkspaceNavigationController, context: Context) {
    let coordinator = context.coordinator
    coordinator.list.rootView = AnyView(list().environment(\.self, context.environment))
    coordinator.chat.rootView = AnyView(
      chat().environment(\.self, context.environment)
        .environment(\.workspaceChatPresentation, coordinator.presentation))
    coordinator.requestedSidebarOpen = sidebar.isOpen
    // Reconcile in UIKit's layout lifecycle, outside SwiftUI's update transaction.
    navigation.view.setNeedsLayout()
  }

  static func dismantleUIViewController(
    _ navigation: WorkspaceNavigationController, coordinator: Coordinator
  ) {
    navigation.applySelection = nil
    navigation.delegate = nil
    navigation.popPan.isEnabled = false
    coordinator.sidebar.setTransitioning(false)
  }

  @MainActor
  final class Coordinator: NSObject, UINavigationControllerDelegate {
    let sidebar: SidebarInteraction
    // Retain both hosts across a pop so drafts, list position and transcript state survive.
    let list = UIHostingController(rootView: AnyView(EmptyView()))
    let presentation: WorkspaceChatPresentation
    let chat: WorkspaceChatHostingController
    var requestedSidebarOpen: Bool
    private weak var navigation: WorkspaceNavigationController?
    private var transitionTarget: Bool?

    init(sidebar: SidebarInteraction) {
      let presentation = WorkspaceChatPresentation()
      self.sidebar = sidebar
      self.presentation = presentation
      chat = WorkspaceChatHostingController(presentation: presentation)
      requestedSidebarOpen = sidebar.isOpen
      // The chat's keyboard must not move the sidebar's list or footer during navigation.
      list.safeAreaRegions = .container
    }

    func install(on navigation: WorkspaceNavigationController) {
      self.navigation = navigation
      navigation.delegate = self
      navigation.applySelection = { [weak self] in self?.applySelection() }
    }

    func navigationController(
      _ navigationController: UINavigationController,
      animationControllerFor operation: UINavigationController.Operation,
      from fromVC: UIViewController, to toVC: UIViewController
    ) -> (any UIViewControllerAnimatedTransitioning)? {
      operation == .pop ? navigation?.popPan.transition : nil
    }

    func navigationController(
      _ navigationController: UINavigationController,
      interactionControllerFor animationController: any UIViewControllerAnimatedTransitioning
    ) -> (any UIViewControllerInteractiveTransitioning)? {
      animationController as? WorkspacePopTransition
    }

    private func applySelection() {
      guard let navigation, transitionTarget == nil,
        navigation.transitionCoordinator == nil,
        (navigation.topViewController === list) != requestedSidebarOpen
      else { return }
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
      presentation.beginTransition(showsChat: !showsSidebar)
      let transition = navigationController.transitionCoordinator
      transition?.notifyWhenInteractionChanges { [weak self] context in
        if showsSidebar && context.isCancelled { self?.presentation.cancelDeparture() }
      }
      // A native pop (including accessibility return) starts outside the SwiftUI selection.
      if requestedSidebarOpen != showsSidebar {
        requestedSidebarOpen = showsSidebar
        sidebar.setOpen(showsSidebar)
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
      // UIKit reports the actual surviving page, including cancelled and unanimated transitions.
      presentation.finishTransition(showsChat: !showsSidebar)
      sidebar.setTransitioning(false)
      navigationController.view.setNeedsLayout()
    }
  }
}

final class WorkspaceNavigationController: UINavigationController {
  var applySelection: (() -> Void)?
  private(set) lazy var popPan = WorkspacePopPanGestureRecognizer(navigation: self)

  override func viewDidLoad() {
    super.viewDidLoad()
    interactivePopGestureRecognizer?.isEnabled = false
    interactiveContentPopGestureRecognizer?.isEnabled = false
    view.addGestureRecognizer(popPan)
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    applySelection?()
  }
}
