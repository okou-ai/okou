import ChatDomain
import SwiftUI
import Textual

@MainActor
protocol ConversationCollectionScrolling: AnyObject {
  func scrollTo(_ id: String, anchor: UnitPoint, animated: Bool)
  func captureReadingPosition() -> ConversationReadingPosition?
}

@MainActor
final class ConversationCollectionScroll {
  private weak var owner: (any ConversationCollectionScrolling)?
  private var request: (String, UnitPoint, Bool)?

  func scrollTo(_ id: String, anchor: UnitPoint, animated: Bool = false) {
    guard let owner else {
      request = (id, anchor, animated)
      return
    }
    owner.scrollTo(id, anchor: anchor, animated: animated)
  }

  func captureReadingPosition() -> ConversationReadingPosition? {
    owner?.captureReadingPosition()
  }

  func attach(_ owner: any ConversationCollectionScrolling) {
    self.owner = owner
    if let request {
      self.request = nil
      owner.scrollTo(request.0, anchor: request.1, animated: request.2)
    }
  }
  func detach(_ owner: any ConversationCollectionScrolling) {
    if self.owner === owner { self.owner = nil }
  }
}
