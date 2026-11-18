import ChatDomain
import SwiftUI

struct ConversationPositionInput<Content: View> {
  let source: ConversationCollectionView<Content>
  let collection: UICollectionView
  let dataSource: UICollectionViewDiffableDataSource<Int, String>
  let layout: UICollectionViewFlowLayout
  let displayedRows: [String: ConversationCollectionRow]
  let displayedWidth: CGFloat
  let displayedCategory: UIContentSizeCategory
  let traits: UITraitCollection
  let stopped: Bool
}

@MainActor
final class ConversationCollectionPosition<Content: View> {
  private let input: @MainActor () -> ConversationPositionInput<Content>?
  private let didEndScrolling: @MainActor () -> Void
  var pendingScroll: (String, UnitPoint, Bool)?
  var sharingTrailingSpace: CGFloat = 0
  var animatesScroll = false
  private var lastMetrics: ConversationCollectionMetrics?
  private var publishesMetrics = false
  private var publishesViewport = false
  private var stopped: Bool { input()?.stopped != false }
  private var isScrolling: Bool {
    guard let collection = input()?.collection else { return false }
    return animatesScroll || collection.isTracking || collection.isDragging
      || collection.isDecelerating
  }
  init(
    input: @escaping @MainActor () -> ConversationPositionInput<Content>?,
    didEndScrolling: @escaping @MainActor () -> Void
  ) {
    self.input = input
    self.didEndScrolling = didEndScrolling
  }

  func publishViewportChange() {
    guard let context = input() else { return }
    let source = context.source
    guard !publishesViewport else { return }
    publishesViewport = true
    source.anchor.layoutDidChange()
    // Preserve intent before a width/font snapshot can replace its geometry.
    // This callback only updates the non-observable anchor, not SwiftUI state.
    if !isScrolling { source.anchor.viewportDidChange?() }
    DispatchQueue.main.async { [weak self] in
      guard let self, !stopped else { return }
      publishesViewport = false
    }
  }

  func captureReadingPosition(retaining ids: Set<String>?) -> ConversationReadingPosition? {
    guard let context = input() else { return nil }
    let collection = context.collection
    let dataSource = context.dataSource
    let layout = context.layout
    let displayedRows = context.displayedRows
    let displayedWidth = context.displayedWidth
    let displayedCategory = context.displayedCategory
    let traitCollection = context.traits
    guard displayedWidth == collection.bounds.width,
      displayedCategory == traitCollection.preferredContentSizeCategory
    else { return nil }
    let top = collection.bounds.minY + collection.adjustedContentInset.top
    let bottom = collection.bounds.maxY - collection.adjustedContentInset.bottom
    let positions: [ConversationReadingPosition] =
      collection.indexPathsForVisibleItems.compactMap { index in
        guard let id = dataSource.itemIdentifier(for: index), ids?.contains(id) ?? true,
          let spacing = displayedRows[id]?.readingContentTopSpacing,
          let frame = layout.layoutAttributesForItem(at: index)?.frame,
          frame.maxY > top, frame.minY + spacing < bottom
        else { return nil }
        return ConversationReadingPosition(messageID: id, offset: frame.minY + spacing - top)
      }
    return positions.min { $0.offset < $1.offset }
  }

  func restoreReadingPosition(_ position: ConversationReadingPosition) {
    guard let context = input() else { return }
    let collection = context.collection
    let dataSource = context.dataSource
    let layout = context.layout
    let displayedRows = context.displayedRows
    let displayedWidth = context.displayedWidth
    let displayedCategory = context.displayedCategory
    let traitCollection = context.traits
    guard displayedWidth == collection.bounds.width,
      displayedCategory == traitCollection.preferredContentSizeCategory,
      let index = dataSource.indexPath(for: position.messageID),
      let spacing = displayedRows[position.messageID]?.readingContentTopSpacing,
      let frame = layout.layoutAttributesForItem(at: index)?.frame
    else { return }
    let insets = collection.adjustedContentInset
    let requested = frame.minY + spacing - insets.top - position.offset
    if displayedRows[position.messageID]?.isShareSelection == true {
      // Hidden work/usage/follow-up rows can shorten the transcript below the
      // reader. Retain only the trailing room needed to avoid clamping them away.
      let maximum = max(
        -insets.top, collection.contentSize.height - collection.bounds.height + insets.bottom)
      if requested > maximum {
        setSharingTrailingSpace(sharingTrailingSpace + requested - maximum)
      }
    }
    let minimum = -insets.top
    let maximum = max(
      minimum, collection.contentSize.height - collection.bounds.height + insets.bottom)
    let y = min(maximum, max(minimum, requested))
    guard abs(y - collection.contentOffset.y) > 0.5 else { return }
    collection.setContentOffset(CGPoint(x: collection.contentOffset.x, y: y), animated: false)
  }

  func setSharingTrailingSpace(_ height: CGFloat) {
    guard let context = input() else { return }
    let collection = context.collection
    let layout = context.layout
    sharingTrailingSpace = height
    // This is scrollable empty content, not an occluding bar or safe area.
    layout.sectionInset.bottom = height
    layout.invalidateLayout()
    collection.layoutIfNeeded()
  }

  func scrollTo(_ id: String, anchor: UnitPoint, animated: Bool) {
    guard let context = input() else {
      pendingScroll = (id, anchor, animated)
      return
    }
    let source = context.source
    let collection = context.collection
    let dataSource = context.dataSource
    let layout = context.layout
    guard source.sendTransition?.isActive != true else { return }
    let lastShareID = source.rows.last.flatMap { $0.isShareSelection ? $0.id : nil }
    let targetID = id == "conversation-bottom" ? lastShareID ?? id : id
    if id == "conversation-bottom", sharingTrailingSpace > 0 {
      setSharingTrailingSpace(0)
    }
    guard let index = dataSource.indexPath(for: targetID) else {
      pendingScroll = (id, anchor, animated)
      return
    }
    collection.layoutIfNeeded()
    guard let attributes = layout.layoutAttributesForItem(at: index) else { return }
    let insets = collection.adjustedContentInset
    let minimum = -insets.top
    let maximum = max(
      minimum, collection.contentSize.height - collection.bounds.height + insets.bottom)
    let requested =
      anchor == .bottom
      ? attributes.frame.maxY - collection.bounds.height + insets.bottom
      : attributes.frame.minY - insets.top
    let y = min(maximum, max(minimum, requested))
    guard abs(y - collection.contentOffset.y) > 0.5 else {
      if animatesScroll {
        collection.setContentOffset(collection.contentOffset, animated: false)
        didEndScrolling()
      }
      publishMetrics()
      return
    }
    let interruptedAnimation = animatesScroll && !animated
    animatesScroll = animated
    if animated { source.phaseChanged(.animating) }
    collection.setContentOffset(CGPoint(x: 0, y: y), animated: animated)
    if interruptedAnimation { didEndScrolling() } else if !animated { publishMetrics() }
  }

  func publishMetrics() {
    guard !stopped, !publishesMetrics else { return }
    publishesMetrics = true
    // Delegate callbacks can also occur during a SwiftUI updateUIViewController pass.
    DispatchQueue.main.async { [weak self] in
      guard let self, let context = input(), !context.stopped else { return }
      let source = context.source
      let collection = context.collection
      let displayedRows = context.displayedRows
      let displayedWidth = context.displayedWidth
      let displayedCategory = context.displayedCategory
      let traitCollection = context.traits
      publishesMetrics = false
      // A width/font transition can change mounted marker geometry before its
      // measured snapshot commits. Keep the previous reading position until then.
      guard
        displayedRows.isEmpty
          || (displayedWidth == collection.bounds.width
            && displayedCategory == traitCollection.preferredContentSizeCategory)
      else { return }
      let insets = collection.adjustedContentInset
      let metrics = ConversationCollectionMetrics(
        height: collection.contentSize.height, offset: collection.contentOffset.y,
        isNearTop: collection.contentOffset.y + insets.top < 100,
        isAwayFromBottom: collection.contentSize.height + insets.bottom - collection.bounds.maxY
          > 20)
      guard metrics != lastMetrics else { return }
      lastMetrics = metrics
      source.metricsChanged(metrics)
    }
  }
}
