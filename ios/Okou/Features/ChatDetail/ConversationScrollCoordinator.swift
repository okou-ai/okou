import Observation
import SwiftUI

/// Owns one detail view's scroll intent; native motion and geometry stay with the collection.
@MainActor @Observable
final class ConversationScrollCoordinator {
  private enum Intent: Equatable {
    case latest(resetWindow: Bool)
    case history
  }

  let anchor = ConversationScrollAnchor()
  let scroll = ConversationCollectionScroll()
  private let conversation: ConversationStore
  private var intent = Intent.latest(resetWindow: false)
  private var hasPositionedHistory = false
  private var isAwayFromBottom = false
  @ObservationIgnored private var phase = ScrollPhase.idle
  @ObservationIgnored private var metrics: ConversationCollectionMetrics?
  @ObservationIgnored private var reduceMotion = false
  @ObservationIgnored private var isActive = false
  @ObservationIgnored private var requestGeneration = UUID()
  @ObservationIgnored private var expansionTask: Task<Void, Never>?

  init(conversation: ConversationStore) { self.conversation = conversation }

  var followsBottom: Bool {
    if case .latest = intent { return true }
    return false
  }

  var showsBottomButton: Bool {
    hasPositionedHistory && isAwayFromBottom && !conversation.visibleMessages.isEmpty
  }

  private var isScrolling: Bool { phase != .idle }
  private var resetsWindowAtBottom: Bool {
    if case .latest(let resetWindow) = intent { return resetWindow }
    return false
  }

  func activate(reduceMotion: Bool) {
    invalidateRequests()
    isActive = true
    self.reduceMotion = reduceMotion
    phase = .idle
    anchor.isScrolling = false
    anchor.revealRow = { [weak self] in self?.scroll.scrollTo($0, anchor: .top) }
    anchor.readingPositionDidChange = { [weak self] position in
      guard let self, isActive, hasPositionedHistory, !followsBottom, !isScrolling else { return }
      conversation.rememberReadingPosition(anchor.preservedPosition ?? position)
    }
    anchor.viewportDidChange = { [weak self] in self?.viewportChanged() }
  }

  func setReduceMotion(_ value: Bool) { reduceMotion = value }

  func deactivate() {
    if !followsBottom { saveReadingPosition() }
    isActive = false
    invalidateRequests()
    anchor.readingPositionDidChange = nil
    anchor.revealRow = nil
    anchor.viewportDidChange = nil
    anchor.cancel()
  }

  func jumpToLatest() {
    guard isActive else { return }
    invalidateRequests()
    intent = .latest(resetWindow: true)
    anchor.cancel()
    conversation.rememberReadingPosition(nil)
    positionAtBottom(animated: true)
  }

  /// Called by the view's cancellable task when the latest displayed message changes.
  func latestMessageChanged() async {
    guard isActive, !conversation.visibleMessages.isEmpty else { return }
    let generation = requestGeneration
    if !hasPositionedHistory, let position = conversation.readingPosition {
      intent = .history
      await Task.yield()
      guard canContinue(generation), !isScrolling else { return }
      anchor.restore(position)
      hasPositionedHistory = true
      return
    }
    guard
      !hasPositionedHistory || followsBottom
        || conversation.pending.contains(where: { $0.id == conversation.visibleMessages.last?.id })
    else { return }
    intent = .latest(resetWindow: resetsWindowAtBottom)
    anchor.cancel()
    conversation.rememberReadingPosition(nil)
    await Task.yield()
    guard canContinue(generation), followsBottom else { return }
    positionAtBottom(animated: hasPositionedHistory)
    hasPositionedHistory = true
  }

  func messagesChanged() {
    guard isActive, hasPositionedHistory, !isScrolling else { return }
    if followsBottom {
      positionAtBottom()
    } else if let position = conversation.readingPosition {
      anchor.restore(position)
    }
  }

  func readingPositionChanged(previousID: String?, currentID: String?) {
    guard isActive, hasPositionedHistory, !followsBottom, !isScrolling,
      previousID != nil, currentID == nil
    else { return }
    intent = .latest(resetWindow: false)
    positionAtBottom()
  }

  func executionStateChanged() {
    if isActive, hasPositionedHistory, followsBottom { positionAtBottom() }
  }

  func phaseChanged(_ phase: ScrollPhase) {
    guard isActive else { return }
    self.phase = phase
    anchor.isScrolling = isScrolling
    if phase == .tracking || phase == .interacting {
      invalidateRequests()
      intent = .history
      // Native interaction establishes the viewport even if initial positioning was deferred.
      hasPositionedHistory = true
      anchor.cancel()
      conversation.rememberReadingPosition(anchor.capture())
    }
    if phase == .idle, hasPositionedHistory, !isAwayFromBottom {
      reachedBottom()
    } else if phase == .idle, hasPositionedHistory, !followsBottom {
      saveReadingPosition()
      if metrics?.isNearTop == true { loadEarlierMessages() }
    }
  }

  func metricsChanged(_ metrics: ConversationCollectionMetrics) {
    guard isActive else { return }
    let oldHeight = self.metrics?.height ?? 0
    // Raw native offsets must not invalidate the view every frame.
    self.metrics = metrics
    if isAwayFromBottom != metrics.isAwayFromBottom {
      isAwayFromBottom = metrics.isAwayFromBottom
    }
    anchor.layoutDidChange()
    if hasPositionedHistory, !followsBottom, !isScrolling { saveReadingPosition() }
    if resetsWindowAtBottom, !metrics.isAwayFromBottom, !isScrolling { reachedBottom() }
    if hasPositionedHistory, followsBottom, metrics.isAwayFromBottom, metrics.height != oldHeight {
      positionAtBottom()
    }
  }

  func loadEarlierMessages() {
    guard isActive, hasPositionedHistory, !isScrolling, conversation.hasEarlierMessages,
      !conversation.isLoadingEarlier, expansionTask == nil
    else { return }
    intent = .history
    saveReadingPosition()
    let generation = requestGeneration
    expansionTask = Task { [weak self] in
      guard let self else { return }
      defer { if requestGeneration == generation { expansionTask = nil } }
      await conversation.loadEarlierMessages()
      guard canContinue(generation), !isScrolling, !followsBottom,
        let position = conversation.readingPosition
      else { return }
      anchor.preserve(position)
    }
  }

  private func viewportChanged() {
    guard isActive, hasPositionedHistory else { return }
    if followsBottom {
      anchor.followBottom()
    } else if let position = conversation.readingPosition {
      anchor.preserve(position)
    }
  }

  private func reachedBottom() {
    let resetWindow = resetsWindowAtBottom
    intent = .latest(resetWindow: false)
    conversation.rememberReadingPosition(nil)
    if resetWindow { conversation.resetRenderWindowToLatest() }
  }

  private func saveReadingPosition() {
    // Recording ordinary user scrolling must not start an offset correction.
    if let position = anchor.preservedPosition ?? anchor.capture() {
      conversation.rememberReadingPosition(position)
    }
  }

  private func positionAtBottom(animated: Bool = false) {
    anchor.followBottom()
    scroll.scrollTo("conversation-bottom", anchor: .bottom, animated: animated && !reduceMotion)
  }

  private func invalidateRequests() {
    requestGeneration = UUID()
    expansionTask?.cancel()
    expansionTask = nil
  }

  private func canContinue(_ generation: UUID) -> Bool {
    isActive && !Task.isCancelled && requestGeneration == generation
  }
}
