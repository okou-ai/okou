import UIKit

@MainActor
final class ConversationAccessibilityCollection: UICollectionView {
  static func configured(frame: CGRect, layout: UICollectionViewFlowLayout)
    -> ConversationAccessibilityCollection
  {
    layout.minimumLineSpacing = 0
    layout.minimumInteritemSpacing = 0
    layout.estimatedItemSize = .zero
    let collection = ConversationAccessibilityCollection(
      frame: frame, collectionViewLayout: layout)
    collection.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    collection.backgroundColor = .clear
    collection.alwaysBounceVertical = true
    // The top is the system's soft edge, the progressive blur ChatGPT and Manus draw:
    // strongest at the screen's edge, clearing toward the content, with no colour of its own.
    // It follows the safe area, so its reach is the status bar band (updateContentInsets).
    // The bottom has none, as everywhere in the app: messages pass plainly under the
    // composer's glass.
    collection.topEdgeEffect.style = .soft
    collection.bottomEdgeEffect.isHidden = true
    collection.keyboardDismissMode = .interactive
    return collection
  }

  var beginsAccessibilityScroll: (() -> Void)?
  override func accessibilityScroll(_ direction: UIAccessibilityScrollDirection) -> Bool {
    guard isUserInteractionEnabled else { return false }
    guard direction == .up || direction == .down else {
      return super.accessibilityScroll(direction)
    }
    let minimum = -adjustedContentInset.top
    let maximum = max(minimum, contentSize.height - bounds.height + adjustedContentInset.bottom)
    let page = max(1, bounds.height - adjustedContentInset.top - adjustedContentInset.bottom)
    let target = min(maximum, max(minimum, contentOffset.y + (direction == .up ? -page : page)))
    guard abs(target - contentOffset.y) > 0.5 else { return false }
    beginsAccessibilityScroll?()
    setContentOffset(CGPoint(x: contentOffset.x, y: target), animated: true)
    return true
  }
}
