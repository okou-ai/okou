import Observation

@MainActor @Observable
final class SidebarInteraction {
  private(set) var isOpen = true
  private(set) var isTransitioning = false

  func setTransitioning(_ transitioning: Bool) {
    isTransitioning = transitioning
  }

  func setOpen(_ open: Bool) {
    isOpen = open
  }
}
