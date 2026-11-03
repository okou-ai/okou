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

    init(parent: SidebarPanGesture) {
      self.parent = parent
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
      guard parent.interaction.allowsDragging else { return false }
      guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return false }
      let velocity = pan.velocity(in: pan.view)
      return SidebarGesturePolicy.canBegin(
        isOpen: parent.interaction.isOpen, sidebarWidth: parent.sidebarWidth,
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
