import UIKit

/// Owns one swipe from touch-down through release. The navigation stack still owns its pages.
final class WorkspacePopPanGestureRecognizer: UIPanGestureRecognizer, UIGestureRecognizerDelegate {
  private weak var navigation: UINavigationController?
  private(set) var transition: WorkspacePopTransition?
  /// A swipe on the For you deck pages its cards; only its leading edge navigates back.
  var requiresLeadingEdge = false
  private var origin: CGPoint?

  init(navigation: UINavigationController) {
    self.navigation = navigation
    super.init(target: nil, action: nil)
    addTarget(self, action: #selector(handlePan))
    delegate = self
    maximumNumberOfTouches = 1
    allowedScrollTypesMask = .continuous
  }

  private var canPop: Bool {
    guard let navigation else { return false }
    return transition == nil && navigation.viewControllers.count > 1
      && navigation.transitionCoordinator == nil
      && navigation.presentedViewController == nil
  }

  private var forward: CGFloat {
    view?.effectiveUserInterfaceLayoutDirection == .rightToLeft ? -1 : 1
  }

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
    super.touchesBegan(touches, with: event)
    guard state == .possible else { return }
    guard canPop, origin == nil, touches.count == 1, let touch = touches.first, let view else {
      state = .failed
      return
    }
    let point = touch.location(in: view)
    origin = point
    if !acceptsStart(at: point, in: view, target: touch.view) {
      state = .failed
    }
  }

  override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
    guard state == .possible, let view, let origin, leadingDistance(origin, in: view) >= 16,
      let touch = touches.first
    else {
      super.touchesMoved(touches, with: event)
      return
    }
    let point = touch.location(in: view)
    let dx = (point.x - origin.x) * forward
    let dy = abs(point.y - origin.y)
    if dx < 0 || (dy > 2 && dy > 2 * dx) {
      state = .failed
      return
    }
    if hypot(dx, dy) > 10 {
      guard dx >= dy else {
        state = .failed
        return
      }
    } else if dx <= 2 || dx <= 2 * dy {
      return
    }
    super.touchesMoved(touches, with: event)
    if state == .possible { state = .began }
  }

  override func reset() {
    super.reset()
    origin = nil
  }

  func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
    guard canPop, let view else { return false }
    if let origin {
      guard leadingDistance(origin, in: view) < 16 else { return true }
      let point = location(in: view)
      let dx = (point.x - origin.x) * forward
      return dx > 0 && dx >= abs(point.y - origin.y)
    }
    // Continuous trackpad scrolls arrive without a UITouch sequence.
    let point = location(in: view)
    guard acceptsStart(at: point, in: view, target: view.hitTest(point, with: nil)) else {
      return false
    }
    let speed = velocity(in: view)
    let dx = speed.x * forward
    return dx >= 4 && abs(speed.y) <= 2.5 * dx
  }

  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer,
    shouldBeRequiredToFailBy otherGestureRecognizer: UIGestureRecognizer
  ) -> Bool {
    guard canPop, let scroll = otherGestureRecognizer.view as? UIScrollView else { return false }
    return otherGestureRecognizer === scroll.panGestureRecognizer
  }

  private func leadingDistance(_ point: CGPoint, in view: UIView) -> CGFloat {
    forward > 0 ? point.x - view.bounds.minX : view.bounds.maxX - point.x
  }

  private func acceptsStart(at point: CGPoint, in view: UIView, target: UIView?) -> Bool {
    let distance = leadingDistance(point, in: view)
    return distance < 16
      || (!requiresLeadingEdge && distance <= view.bounds.width - 16
        && !startsInHorizontalScroll(target))
  }

  private func startsInHorizontalScroll(_ target: UIView?) -> Bool {
    var ancestor = target
    while let current = ancestor {
      if let scroll = current as? UIScrollView, scroll.isScrollEnabled {
        let inset = scroll.adjustedContentInset
        if scroll.alwaysBounceHorizontal
          || scroll.contentSize.width + inset.left + inset.right > scroll.bounds.width + 1
        {
          return true
        }
      }
      ancestor = current.superview
    }
    return false
  }

  @objc private func handlePan() {
    guard let navigation, let view, view.bounds.width > 0 else { return }
    let width = view.bounds.width
    let distance = translation(in: view).x * forward
    let progress = min(1, max(0, distance / width))
    switch state {
    case .began:
      guard canPop else { return }
      let interaction = WorkspacePopTransition { [weak self] in self?.transition = nil }
      transition = interaction
      if navigation.popViewController(animated: true) == nil {
        transition = nil
      } else {
        interaction.update(progress)
      }
    case .changed:
      transition?.update(progress)
    case .ended:
      // A short flick can finish, and reversing before release can still cancel.
      let projectedDistance = distance + velocity(in: view).x * forward * 0.2
      transition?.end(completes: projectedDistance > width / 2)
    case .cancelled, .failed:
      transition?.end(completes: false)
    default:
      break
    }
  }
}
