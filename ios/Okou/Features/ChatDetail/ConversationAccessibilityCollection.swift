import UIKit

@MainActor
final class ConversationAccessibilityCollection: UICollectionView {
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
