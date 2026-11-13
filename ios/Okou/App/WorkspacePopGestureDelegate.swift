import UIKit

/// Coordinates native return gestures with scrolling while the navigation bar is hidden.
@MainActor
final class WorkspacePopGestureDelegate: NSObject, UIGestureRecognizerDelegate {
  private weak var navigation: UINavigationController?
  private weak var gestureRecognizer: UIGestureRecognizer?
  private let original: (any UIGestureRecognizerDelegate)?

  init(navigation: UINavigationController, gestureRecognizer: UIGestureRecognizer) {
    self.navigation = navigation
    self.gestureRecognizer = gestureRecognizer
    original = gestureRecognizer.delegate
    super.init()
    gestureRecognizer.delegate = self
  }

  func uninstall() {
    if gestureRecognizer?.delegate === self {
      gestureRecognizer?.delegate = original
    }
  }

  func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
    guard let navigation, navigation.viewControllers.count > 1,
      navigation.transitionCoordinator == nil,
      let pan = gestureRecognizer as? UIPanGestureRecognizer
    else { return false }
    let velocity = pan.velocity(in: navigation.view)
    let x =
      navigation.view.effectiveUserInterfaceLayoutDirection == .rightToLeft
      ? -velocity.x : velocity.x
    return x > abs(velocity.y)
  }

  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer,
    shouldBeRequiredToFailBy otherGestureRecognizer: UIGestureRecognizer
  ) -> Bool {
    // A vertical scroll must let a horizontal return begin, including during deceleration.
    if let scroll = otherGestureRecognizer.view as? UIScrollView,
      otherGestureRecognizer === scroll.panGestureRecognizer,
      scroll.contentSize.width <= scroll.bounds.width + 1
    {
      return true
    }
    return original?.gestureRecognizer?(
      gestureRecognizer, shouldBeRequiredToFailBy: otherGestureRecognizer) ?? false
  }

  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer,
    shouldRequireFailureOf otherGestureRecognizer: UIGestureRecognizer
  ) -> Bool {
    original?.gestureRecognizer?(
      gestureRecognizer, shouldRequireFailureOf: otherGestureRecognizer) ?? false
  }

  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer,
    shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
  ) -> Bool {
    original?.gestureRecognizer?(
      gestureRecognizer, shouldRecognizeSimultaneouslyWith: otherGestureRecognizer) ?? false
  }

  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch
  ) -> Bool {
    original?.gestureRecognizer?(gestureRecognizer, shouldReceive: touch) ?? true
  }

  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer, shouldReceive press: UIPress
  ) -> Bool {
    original?.gestureRecognizer?(gestureRecognizer, shouldReceive: press) ?? true
  }

  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer, shouldReceive event: UIEvent
  ) -> Bool {
    original?.gestureRecognizer?(gestureRecognizer, shouldReceive: event) ?? true
  }
}
