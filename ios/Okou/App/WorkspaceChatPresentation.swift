import Observation
import SwiftUI
import UIKit

/// Navigation owns when a retained chat editor may acquire focus, not its window attachment.
@MainActor @Observable
final class WorkspaceChatPresentation {
  private(set) var allowsFocus = false
  private(set) var isTransitioning = false
  private(set) var keepsComposerExpanded = false
  @ObservationIgnored private weak var focusedInput: ComposerTextView?
  @ObservationIgnored private weak var deferredInput: ComposerTextView?
  @ObservationIgnored private weak var departingInput: ComposerTextView?

  func deferFocus(_ input: ComposerTextView) {
    deferredInput = input
  }

  func didFocus(_ input: ComposerTextView) {
    focusedInput = input
  }

  func beginTransition(showsChat: Bool) {
    isTransitioning = true
    if !showsChat {
      departingInput = focusedInput?.isFirstResponder == true ? focusedInput : nil
      keepsComposerExpanded = departingInput != nil
      deferredInput = nil
      allowsFocus = false
    }
  }

  func appear() {
    allowsFocus = true
    let input = deferredInput
    deferredInput = nil
    input?.resumeFocus()
  }

  func finishTransition(showsChat: Bool) {
    allowsFocus = showsChat
    if showsChat {
      cancelDeparture()
    } else {
      focusedInput?.setFocused(false)
      deferredInput = nil
    }
    departingInput = nil
    keepsComposerExpanded = false
    isTransitioning = false
  }

  func cancelDeparture() {
    // Restore focus as UIKit starts the interactive rollback, keeping the native selection.
    allowsFocus = true
    departingInput?.setFocused(true)
  }

  func disappear() {
    allowsFocus = false
  }
}

extension EnvironmentValues {
  @Entry var workspaceChatPresentation: WorkspaceChatPresentation?
}

final class WorkspaceChatHostingController: UIViewController {
  let presentation: WorkspaceChatPresentation
  private let host = UIHostingController(rootView: AnyView(EmptyView()))

  var rootView: AnyView {
    get { host.rootView }
    set { host.rootView = newValue }
  }

  init(presentation: WorkspaceChatPresentation) {
    self.presentation = presentation
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = UIColor(OkouColor.background)
    addChild(host)
    view.addSubview(host.view)
    host.view.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      host.view.topAnchor.constraint(equalTo: view.topAnchor),
      host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      // A full-height host lets SwiftUI animate its keyboard safe area and bottom inset together.
      host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor)
    ])
    host.didMove(toParent: self)
  }

  override func viewIsAppearing(_ animated: Bool) {
    super.viewIsAppearing(animated)
    // The incoming page has its final geometry, before UIKit starts its transition.
    view.layoutIfNeeded()
    presentation.appear()
  }

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    presentation.disappear()
  }
}
