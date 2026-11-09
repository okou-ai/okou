import Observation
import SwiftUI
import UIKit

/// Reject vertical drags before recognition so the transcript retains its native scrolling.
struct SidebarPanGesture: UIGestureRecognizerRepresentable {
  let interaction: SidebarInteraction
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
    interaction.attachPanGesture(recognizer)
    return recognizer
  }

  func updateUIGestureRecognizer(_ recognizer: UIPanGestureRecognizer, context: Context) {
    context.coordinator.parent = self
    interaction.attachPanGesture(recognizer)
  }

  func handleUIGestureRecognizerAction(_ recognizer: UIPanGestureRecognizer, context: Context) {
    guard interaction.allowsDragging else { return }
    let translation = recognizer.translation(in: recognizer.view).x
    switch recognizer.state {
    case .began, .changed:
      changed(translation)
    case .ended, .cancelled:
      ended(translation, recognizer.velocity(in: recognizer.view).x, recognizer.state == .cancelled)
    default: break
    }
  }

  static func dismantleUIGestureRecognizer(
    _ recognizer: UIPanGestureRecognizer, coordinator: Coordinator
  ) {
    coordinator.parent.interaction.detachPanGesture(recognizer)
  }

  final class Coordinator: NSObject, UIGestureRecognizerDelegate {
    var parent: SidebarPanGesture
    private var startX: CGFloat = 0
    private var startsInHorizontalScroller = false

    init(parent: SidebarPanGesture) {
      self.parent = parent
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
      guard parent.interaction.allowsDragging else { return false }
      guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return false }
      let velocity = pan.velocity(in: pan.view)
      return SidebarGesturePolicy.canBegin(
        isOpen: parent.interaction.isOpen, startX: startX, velocity: velocity,
        startsInHorizontalScroller: startsInHorizontalScroller)
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch)
      -> Bool
    {
      let location = touch.location(in: gestureRecognizer.view)
      // Pan translation excludes its recognition threshold; retain the actual touch origin.
      startX = location.x
      startsInHorizontalScroller = Self.isInHorizontalScroller(touch.view)
      return true
    }

    /// A code block or table under the finger keeps its own sideways scrolling.
    private static func isInHorizontalScroller(_ view: UIView?) -> Bool {
      var current = view
      while let candidate = current {
        if let scroller = candidate as? UIScrollView, scroller.isScrollEnabled,
          scroller.contentSize.width > scroller.bounds.width + 1
        {
          return true
        }
        current = candidate.superview
      }
      return false
    }

    func gestureRecognizer(
      _ gestureRecognizer: UIGestureRecognizer,
      shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
      // Scroll views keep scrolling alongside (gestureRecognizerShouldBegin rejects vertical
      // drags). Anything else, such as a chat row's tap, gives way once the page swipe is
      // recognized, so closing the sidebar over a row does not also open that chat.
      return otherGestureRecognizer is UIPanGestureRecognizer
    }
  }
}

/// Swiping moves between the chat and the full-screen sidebar like turning a page: right from
/// anywhere in the chat opens it, left from anywhere in the sidebar closes it. Only content
/// that scrolls sideways keeps the finger (a code block or table in the chat); from there the
/// chat still opens the sidebar from its leading edge.
/// Chat rows swipe right for their actions, so a left swipe on a row closes the sidebar too.
enum SidebarGesturePolicy {
  static let leadingEdge: CGFloat = 28

  static func canBegin(
    isOpen: Bool, startX: CGFloat, velocity: CGPoint, startsInHorizontalScroller: Bool
  ) -> Bool {
    guard abs(velocity.x) > abs(velocity.y) * 1.5 else { return false }
    if isOpen {
      return velocity.x < 0 && !startsInHorizontalScroller
    }
    return velocity.x > 0 && (startX <= leadingEdge || !startsInHorizontalScroller)
  }

  static func settlesOpen(
    wasOpen: Bool, sidebarWidth: CGFloat, translation: CGFloat, velocity: CGFloat, cancelled: Bool
  ) -> Bool {
    if cancelled { return wasOpen }
    if abs(velocity) > 450 { return velocity > 0 }
    return (wasOpen ? sidebarWidth : 0) + translation > sidebarWidth / 2
  }
}

/// The sidebar owns suspension synchronously, before SwiftUI renders its next frame.
@MainActor
protocol SidebarScrollParticipant: AnyObject {
  func setSidebarActive(_ active: Bool)
}

@MainActor @Observable
final class SidebarInteraction {
  private(set) var isOpen = false
  private(set) var translation: CGFloat?
  @ObservationIgnored private weak var transcript: (any SidebarScrollParticipant)?
  @ObservationIgnored private weak var panGesture: UIPanGestureRecognizer?
  @ObservationIgnored private var menuPresentations: Set<UUID> = []

  private var isActive: Bool { isOpen || translation != nil }
  var allowsDragging: Bool { menuPresentations.isEmpty }

  func attachPanGesture(_ recognizer: UIPanGestureRecognizer) {
    panGesture = recognizer
    recognizer.isEnabled = allowsDragging
  }

  func detachPanGesture(_ recognizer: UIPanGestureRecognizer) {
    guard panGesture === recognizer else { return }
    panGesture = nil
    cancelDrag()
  }

  func beginMenuPresentation() -> UUID {
    let id = UUID()
    menuPresentations.insert(id)
    // Cancel an existing pan synchronously, without waiting for a SwiftUI update.
    panGesture?.isEnabled = false
    cancelDrag()
    return id
  }

  func endMenuPresentation(_ id: UUID) {
    guard menuPresentations.remove(id) != nil else { return }
    panGesture?.isEnabled = allowsDragging
  }

  func dragChanged(_ translation: CGFloat) {
    self.translation = translation
    transcript?.setSidebarActive(true)
  }

  func endDrag(translation: CGFloat, velocity: CGFloat, cancelled: Bool, sidebarWidth: CGFloat) {
    setOpen(
      SidebarGesturePolicy.settlesOpen(
        wasOpen: isOpen, sidebarWidth: sidebarWidth, translation: translation,
        velocity: velocity, cancelled: cancelled))
  }

  func setOpen(_ open: Bool) {
    isOpen = open
    translation = nil
    transcript?.setSidebarActive(isActive)
  }

  func cancelDrag() {
    translation = nil
    transcript?.setSidebarActive(isActive)
  }

  func attach(_ transcript: any SidebarScrollParticipant) {
    if self.transcript !== transcript { self.transcript?.setSidebarActive(false) }
    self.transcript = transcript
    transcript.setSidebarActive(isActive)
  }

  func detach(_ transcript: any SidebarScrollParticipant) {
    transcript.setSidebarActive(false)
    if self.transcript === transcript { self.transcript = nil }
  }
}
