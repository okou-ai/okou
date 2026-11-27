import ChatDomain
import SwiftUI
import Textual

/// Presentation revisions include every input that can change a row's measured size.
struct ConversationCollectionRow: Equatable, Identifiable {
  let content: Content
  var animatesAvatar = false
  /// A share group keeps one selection target even when its user messages span midnight.
  var interiorDates: [String: String] = [:]

  /// Avatar motion switches between `.animated` and `.still` inside the same fixed avatar frame.
  func hasSameMeasuredLayout(as other: Self) -> Bool {
    content == other.content && interiorDates == other.interiorDates
  }

  enum Content: Equatable {
    case dateDivider(before: String, label: String)
    case earlier
    case share(ChatShareGroup, topSpacing: CGFloat)
    case message(
      ChatMessage, showsAvatar: Bool, topSpacing: CGFloat, pendingRetry: Bool?, isSending: Bool,
      isWorkHistory: Bool = false, showsActions: Bool = false)
    case work(
      ChatWorkSection, expanded: Bool, showsAvatar: Bool, topSpacing: CGFloat, failed: Bool = false)
    case footer(ChatExecutionState, showsAvatar: Bool)
    case failure(
      ChatMessage, AssistantFailureState, showsAvatar: Bool, topSpacing: CGFloat,
      providerMessage: String? = nil)
    case finished(label: String, followups: ChatRecommendedFollowupSource?, showsAvatar: Bool)
    case usage(runID: String, actionsFor: ChatMessage?)
  }

  static let messageHorizontalInset: CGFloat = 20
  static let assistantLeadingInset: CGFloat = 6

  var id: String {
    switch content {
    case .share(let group, _): group.id
    case .dateDivider(let id, _): "date:\(id)"
    case .earlier: "conversation-earlier"
    case .message(let message, _, _, _, _, _, _): message.id
    case .work(let section, _, _, _, _): section.id
    case .footer: "conversation-bottom"
    case .failure(let message, _, _, _, _): message.id
    case .finished: "conversation-finished"
    case .usage(let runID, _): "usage:\(runID)"
    }
  }

  var message: ChatMessage? {
    if case .message(let message, _, _, _, _, _, _) = content { return message }
    if case .failure(let message, _, _, _, _) = content { return message }
    if case .share(let group, _) = content { return group.messages.first }
    return nil
  }

  var isMessageContent: Bool {
    switch content {
    case .message, .failure, .work, .share: true
    case .dateDivider, .earlier, .footer, .finished, .usage: false
    }
  }

  var readingContentTopSpacing: CGFloat? {
    switch content {
    case .message(_, _, let spacing, _, _, _, _), .work(_, _, _, let spacing, _),
      .failure(_, _, _, let spacing, _), .share(_, let spacing):
      spacing
    case .usage(_, let answer): answer == nil ? 0 : OkouSpace.sm
    case .dateDivider, .earlier, .footer, .finished: nil
    }
  }

  /// Sharing replaces a work header with a selection mark above the answer.
  /// Keep the body, rather than that changing header, at the reader's offset.
  var sharingBodyInset: CGFloat {
    switch content {
    case .share(let group, _) where group.messages.first?.role == .assistant:
      OkouAvatarSize.message + OkouSpace.sm
    case .message(let message, true, _, _, _, _, _) where message.role == .assistant:
      OkouAvatarSize.message + OkouSpace.sm
    default: 0
    }
  }

  var isShareSelection: Bool {
    if case .share = content { return true }
    return false
  }
}

struct ConversationCollectionMetrics: Equatable {
  let height: CGFloat
  let offset: CGFloat
  let isNearTop: Bool
  let isAwayFromBottom: Bool
}

extension ConversationRowMarker {
  func isPresented(in cell: UICollectionViewCell, scale: CGFloat) -> Bool {
    var ancestor = superview
    while let view = ancestor {
      if view === cell {
        // Reused SwiftUI content can briefly wrap at a near-zero width and overflow
        // its measured cell. That temporary box must not become a reading anchor.
        let rect = convert(bounds, to: cell)
        let pixel = 1 / scale
        return rect.width > 0 && rect.height > 0
          && cell.bounds.insetBy(dx: -pixel, dy: -pixel).contains(rect)
      }
      ancestor = view.superview
    }
    return false
  }
}

struct ConversationPreparedRows {
  let rows: [ConversationCollectionRow]
  let measurements: [String: ConversationMeasurementCache.Measurement]
}

struct ConversationObservedHeight {
  let row: ConversationCollectionRow
  let width: CGFloat
  let category: UIContentSizeCategory
  let height: CGFloat
}
