import ChatDomain
import SwiftUI
import Textual

@MainActor
protocol ConversationCollectionScrolling: AnyObject {
  func scrollTo(_ id: String, anchor: UnitPoint, animated: Bool)
  func captureReadingPosition() -> ConversationReadingPosition?
}

struct ConversationScrollRequest {
  let id: String
  let anchor: UnitPoint
  let animated: Bool
}

@MainActor
final class ConversationCollectionScroll {
  private weak var owner: (any ConversationCollectionScrolling)?
  private var request: ConversationScrollRequest?

  func scrollTo(_ id: String, anchor: UnitPoint, animated: Bool = false) {
    guard let owner else {
      request = ConversationScrollRequest(id: id, anchor: anchor, animated: animated)
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
      owner.scrollTo(request.id, anchor: request.anchor, animated: request.animated)
    }
  }
  func detach(_ owner: any ConversationCollectionScrolling) {
    if self.owner === owner { self.owner = nil }
  }
}
