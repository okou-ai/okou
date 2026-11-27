import Foundation
import Observation

enum WorkspacePage {
  case forYou, chat
}

@MainActor @Observable
final class SidebarInteraction {
  /// The chat list is the root of every path.
  var path: [WorkspacePage] = [] {
    didSet {
      if oldValue != path { beginVisit() }
    }
  }
  /// Returning to the same page starts a new opportunity for feedback.
  private(set) var visit = UUID()

  func beginVisit() { visit = UUID() }

  var isOpen: Bool { path.isEmpty }
  var showsChat: Bool { path.last == .chat }
  private(set) var isTransitioning = false

  func openForYou() { path = [.forYou] }

  func goBack() {
    _ = path.popLast()
  }

  func setTransitioning(_ transitioning: Bool) {
    isTransitioning = transitioning
  }

  func setOpen(_ open: Bool) {
    path = open ? [] : [.chat]
  }
}
