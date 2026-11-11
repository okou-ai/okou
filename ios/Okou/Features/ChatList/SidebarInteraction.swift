import Observation
import UIKit

/// The sidebar owns suspension synchronously, before SwiftUI renders its next frame.
@MainActor
protocol SidebarScrollParticipant: AnyObject {
  func setSidebarActive(_ active: Bool)
}

@MainActor @Observable
final class SidebarInteraction {
  private(set) var isOpen = false
  private(set) var isTransitioning = false
  @ObservationIgnored private weak var transcript: (any SidebarScrollParticipant)?
  @ObservationIgnored private var navigationGestures: [UIGestureRecognizer] = []
  @ObservationIgnored private var menuPresentations: Set<UUID> = []

  private var isActive: Bool { isOpen || isTransitioning }
  var allowsDragging: Bool { menuPresentations.isEmpty }

  func setNavigationGestures(_ recognizers: [UIGestureRecognizer]) {
    navigationGestures = recognizers
    for recognizer in navigationGestures { recognizer.isEnabled = allowsDragging }
  }

  func beginMenuPresentation() -> UUID {
    let id = UUID()
    menuPresentations.insert(id)
    // The lifted menu button must return before another navigation gesture starts.
    for recognizer in navigationGestures { recognizer.isEnabled = false }
    return id
  }

  func endMenuPresentation(_ id: UUID) {
    guard menuPresentations.remove(id) != nil else { return }
    for recognizer in navigationGestures { recognizer.isEnabled = allowsDragging }
  }

  func setTransitioning(_ transitioning: Bool) {
    isTransitioning = transitioning
    transcript?.setSidebarActive(isActive)
  }

  func setOpen(_ open: Bool) {
    isOpen = open
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
