import SwiftUI
import UIKit

/// Reject vertical drags before recognition so the transcript retains its native scrolling.
struct SidebarPanGesture: UIGestureRecognizerRepresentable {
  let isOpen: Bool
  let sidebarWidth: CGFloat
  let changed: (CGFloat) -> Void
  let ended: (CGFloat, CGFloat, Bool) -> Void

  func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator {
    Coordinator(parent: self)
  }

  func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
    let recognizer = UIPanGestureRecognizer()
    recognizer.maximumNumberOfTouches = 1
    recognizer.delegate = context.coordinator
    return recognizer
  }

  func updateUIGestureRecognizer(_ recognizer: UIPanGestureRecognizer, context: Context) {
    context.coordinator.parent = self
  }

  func handleUIGestureRecognizerAction(_ recognizer: UIPanGestureRecognizer, context: Context) {
    let translation = recognizer.translation(in: recognizer.view).x
    switch recognizer.state {
    case .began, .changed:
      changed(translation)
    case .ended, .cancelled:
      ended(translation, recognizer.velocity(in: recognizer.view).x, recognizer.state == .cancelled)
    default: break
    }
  }

  final class Coordinator: NSObject, UIGestureRecognizerDelegate {
    var parent: SidebarPanGesture
    private var startX: CGFloat = 0

    init(parent: SidebarPanGesture) {
      self.parent = parent
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
      guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return false }
      let velocity = pan.velocity(in: pan.view)
      return SidebarGesturePolicy.canBegin(
        isOpen: parent.isOpen, sidebarWidth: parent.sidebarWidth,
        startX: startX, velocity: velocity)
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch)
      -> Bool
    {
      let location = touch.location(in: gestureRecognizer.view)
      // Pan translation excludes its recognition threshold; retain the actual touch origin.
      startX = location.x
      return true
    }

    func gestureRecognizer(
      _ gestureRecognizer: UIGestureRecognizer,
      shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
      // SwiftUI's drag/selection recognizers are not necessarily UIPanGestureRecognizer.
      // gestureRecognizerShouldBegin rejects unrelated drags by direction and origin.
      return true
    }
  }
}

enum SidebarGesturePolicy {
  static func canBegin(
    isOpen: Bool, sidebarWidth: CGFloat, startX: CGFloat, velocity: CGPoint
  ) -> Bool {
    guard abs(velocity.x) > abs(velocity.y) * 1.5 else { return false }
    if isOpen {
      // Keep the sidebar list's archive swipe and horizontal controls available.
      return startX >= sidebarWidth && velocity.x < 0
    }
    // Leave code blocks and tables free to scroll horizontally outside the leading edge.
    return startX <= 28 && velocity.x > 0
  }

  static func settlesOpen(
    wasOpen: Bool, sidebarWidth: CGFloat, translation: CGFloat, velocity: CGFloat, cancelled: Bool
  ) -> Bool {
    if cancelled { return wasOpen }
    if abs(velocity) > 450 { return velocity > 0 }
    return (wasOpen ? sidebarWidth : 0) + translation > sidebarWidth / 2
  }
}
