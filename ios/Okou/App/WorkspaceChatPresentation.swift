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

final class WorkspaceChatHostingController: UIHostingController<AnyView> {
  let presentation: WorkspaceChatPresentation
  private var departureSnapshot: UIView?

  init(presentation: WorkspaceChatPresentation) {
    self.presentation = presentation
    super.init(rootView: AnyView(EmptyView()))
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  func beginDeparture() {
    guard departureSnapshot == nil, viewIfLoaded?.window != nil,
      let snapshot = view.snapshotView(afterScreenUpdates: false)
    else { return }
    // UIKit still moves the page and keyboard. Hold only the departing page's contents
    // so keyboard safe-area changes cannot recenter it during an interactive return.
    snapshot.frame = view.bounds
    snapshot.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    snapshot.isUserInteractionEnabled = false
    snapshot.accessibilityElementsHidden = true
    view.addSubview(snapshot)
    departureSnapshot = snapshot
  }

  func finishDeparture() {
    guard let departureSnapshot else { return }
    view.layoutIfNeeded()
    departureSnapshot.removeFromSuperview()
    self.departureSnapshot = nil
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
