import SwiftUI
import UIKit

/// Workspace pages keep their own chrome and share one UIKit navigation stack.
struct WorkspaceNavigation<Sidebar: View, ForYou: View, Chat: View>: UIViewControllerRepresentable {
  let sidebar: SidebarInteraction
  let forYouState: ForYouStore.NavigationState
  @ViewBuilder let list: () -> Sidebar
  @ViewBuilder let forYou: () -> ForYou
  @ViewBuilder let chat: () -> Chat

  func makeCoordinator() -> Coordinator { Coordinator(sidebar: sidebar) }

  func makeUIViewController(context: Context) -> WorkspaceNavigationController {
    let coordinator = context.coordinator
    let navigation = WorkspaceNavigationController()
    navigation.setNavigationBarHidden(true, animated: false)
    updatePages(coordinator, environment: context.environment)
    navigation.setViewControllers(coordinator.controllers, animated: false)
    coordinator.install(on: navigation)
    return navigation
  }

  func updateUIViewController(_ navigation: WorkspaceNavigationController, context: Context) {
    let coordinator = context.coordinator
    updatePages(coordinator, environment: context.environment)
    let onDeck = sidebar.path.last == .forYou
    navigation.popPan.requiresLeadingEdge = onDeck && forYouState == .showingCard
    navigation.popPan.isEnabled = !(onDeck && forYouState == .busy)
    // Reconcile in UIKit's layout lifecycle, outside SwiftUI's update transaction.
    navigation.view.setNeedsLayout()
  }

  private func updatePages(_ coordinator: Coordinator, environment: EnvironmentValues) {
    coordinator.list.rootView = AnyView(list().environment(\.self, environment))
    coordinator.forYou.rootView = AnyView(forYou().environment(\.self, environment))
    coordinator.chat.rootView = AnyView(
      chat().environment(\.self, environment)
        .environment(\.workspaceChatPresentation, coordinator.presentation))
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
    // Returning to a page restores its host, including the card or draft the user left.
    let list = UIHostingController(rootView: AnyView(EmptyView()))
    let forYou = UIHostingController(rootView: AnyView(EmptyView()))
    let presentation: WorkspaceChatPresentation
    let chat: WorkspaceChatHostingController
    private weak var navigation: WorkspaceNavigationController?
    private var pathAtTransitionStart: [WorkspacePage]?

    init(sidebar: SidebarInteraction) {
      let presentation = WorkspaceChatPresentation()
      self.sidebar = sidebar
      self.presentation = presentation
      chat = WorkspaceChatHostingController(presentation: presentation)
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

    var controllers: [UIViewController] {
      [list]
        + sidebar.path.map { page in
          switch page {
          case .forYou: forYou
          case .chat: chat
          }
        }
    }

    private func applySelection() {
      guard let navigation, pathAtTransitionStart == nil, navigation.transitionCoordinator == nil
      else { return }
      let pages = controllers
      guard navigation.viewControllers != pages else { return }
      navigation.setViewControllers(pages, animated: navigation.topViewController !== pages.last)
    }

    func navigationController(
      _ navigationController: UINavigationController, willShow viewController: UIViewController,
      animated: Bool
    ) {
      pathAtTransitionStart = sidebar.path
      sidebar.setTransitioning(true)
      let showsChat = viewController === chat
      presentation.beginTransition(showsChat: showsChat)
      let transition = navigationController.transitionCoordinator
      transition?.notifyWhenInteractionChanges { [weak self] context in
        if !showsChat && context.isCancelled { self?.presentation.cancelDeparture() }
      }
    }

    func navigationController(
      _ navigationController: UINavigationController, didShow viewController: UIViewController,
      animated: Bool
    ) {
      // Commit a gesture only after UIKit settles. A cancelled swipe keeps the same visit,
      // and a newer notification or deep link still gets its turn in the next layout.
      if sidebar.path == pathAtTransitionStart {
        sidebar.path = navigationController.viewControllers.dropFirst().map { controller in
          controller === forYou ? .forYou : .chat
        }
      }
      pathAtTransitionStart = nil
      presentation.finishTransition(showsChat: viewController === chat)
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
