import UIKit

/// The native pop recognizers wait on this recognizer. Failing releases them to begin;
/// recognizing rules out a pop for this touch without consuming the scroll or tap.
final class WorkspacePopDirectionRecognizer: UIGestureRecognizer {
  private var origin: CGPoint?
  private var forward: CGFloat = 1

  override init(target: Any?, action: Selector?) {
    super.init(target: target, action: action)
    cancelsTouchesInView = false
    delaysTouchesEnded = false
  }

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
    guard origin == nil, touches.count == 1, let touch = touches.first, let view else {
      state = .recognized
      return
    }
    let point = touch.location(in: view)
    origin = point
    forward = view.effectiveUserInterfaceLayoutDirection == .rightToLeft ? -1 : 1
    let start = forward > 0 ? point.x - view.bounds.minX : view.bounds.maxX - point.x
    if start < 16 {
      state = .failed
    } else if start > view.bounds.width - 16 || startsInHorizontalScroll(touch.view) {
      state = .recognized
    }
  }

  override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
    guard let origin, let touch = touches.first else { return }
    let point = touch.location(in: view)
    let dx = (point.x - origin.x) * forward
    let dy = abs(point.y - origin.y)
    if dx < 0 {
      state = .recognized
    } else if hypot(dx, dy) > 10 {
      state = dx >= dy ? .failed : .recognized
    } else if dy > 2 && dy > 2 * dx {
      state = .recognized
    } else if dx > 2 && dx > 2 * dy {
      state = .failed
    }
  }

  override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
    state = .recognized
  }

  override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
    state = .failed
  }

  override func reset() {
    super.reset()
    origin = nil
  }

  override func canPrevent(_ preventedGestureRecognizer: UIGestureRecognizer) -> Bool { false }

  override func canBePrevented(by preventingGestureRecognizer: UIGestureRecognizer) -> Bool {
    false
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
}
