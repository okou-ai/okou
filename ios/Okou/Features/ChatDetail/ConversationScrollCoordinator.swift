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
  let sendTransition = ConversationSendTransition()
  private let conversation: ConversationStore
  private var intent = Intent.latest(resetWindow: false)
  private var hasPositionedHistory = false
  private var isAwayFromBottom = false
  private(set) var isLoadingEarlier = false
  @ObservationIgnored private var phase = ScrollPhase.idle
  @ObservationIgnored private var metrics: ConversationCollectionMetrics?
  @ObservationIgnored private var reduceMotion = false
  @ObservationIgnored private var isActive = false
  @ObservationIgnored private var requestGeneration = UUID()
  @ObservationIgnored private var expansionTask: Task<Void, Never>?
  @ObservationIgnored private var localSendMessageID: String?
  @ObservationIgnored private var userScrollPending = false
  @ObservationIgnored private var earlierRequestID: UUID?
  @ObservationIgnored private var earlierExpansionFinished = false
  @ObservationIgnored private var presentedFirstItemID: String?

  init(conversation: ConversationStore) {
    self.conversation = conversation
    sendTransition.didEnd = { [weak conversation] in conversation?.releaseRenderWindow() }
  }

  var followsBottom: Bool {
    if case .latest = intent { return true }
    return false
  }

  var showsBottomButton: Bool {
    hasPositionedHistory && isAwayFromBottom && !sendTransition.isActive
      && !conversation.visibleMessages.isEmpty
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
    userScrollPending = false
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
    earlierRequestID = nil
    isLoadingEarlier = false
    earlierExpansionFinished = false
    anchor.readingPositionDidChange = nil
    anchor.revealRow = nil
    anchor.viewportDidChange = nil
    anchor.cancel()
    sendTransition.cancel()
    localSendMessageID = nil
  }

  func send() async { await conversation.send(willSend: prepareSend) }

  func prepareSend(messageID: String) {
    guard isActive else { return }
    invalidateRequests()
    intent = .latest(resetWindow: false)
    hasPositionedHistory = true
    localSendMessageID = messageID
    anchor.cancel()
    conversation.rememberReadingPosition(nil)
    let composer = conversation.composer
    let canAnimateText =
      conversation.attachmentDraft.items.isEmpty
      && composer.value.draftUserMessage.parts.allSatisfy { $0.type == "text" }
      && composer.editor.view?.markedTextRange == nil
    sendTransition.begin(
      messageID: messageID, reduceMotion: reduceMotion,
      sourceView: canAnimateText ? composer.editor.view : nil)
    if sendTransition.isActive { conversation.preserveRenderWindow() }
  }

  func jumpToLatest() {
    guard isActive else { return }
    cancelSendTransition()
    invalidateRequests()
    intent = .latest(resetWindow: true)
    anchor.cancel()
    conversation.rememberReadingPosition(nil)
    positionAtBottom(animated: true)
  }

  func reveal(_ position: ConversationReadingPosition) {
    guard isActive else { return }
    cancelSendTransition()
    invalidateRequests()
    intent = .history
    anchor.cancel()
    conversation.rememberReadingPosition(position)
    anchor.restore(position)
    hasPositionedHistory = true
  }

  func toggleWorkHistory(_ sectionID: String) {
    guard isActive else { return }
    cancelSendTransition()
    invalidateRequests()
    intent = .history
    // Keep the tapped control at the same offset while its native child rows change.
    let position = anchor.capture(messageID: sectionID) ?? anchor.capture()
    anchor.cancel()
    conversation.rememberReadingPosition(position)
    conversation.toggleWorkHistory(sectionID)
    if let position = conversation.readingPosition { anchor.restore(position) }
  }

  /// Called by the view's cancellable task when the latest displayed message changes.
  func latestMessageChanged() async {
    guard isActive, !conversation.visibleMessages.isEmpty else { return }
    guard !sendTransition.isActive,
      conversation.visibleMessages.last?.id != localSendMessageID
    else { return }
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
    if isActive, hasPositionedHistory, followsBottom, !isScrolling { positionAtBottom() }
  }

  func phaseChanged(_ phase: ScrollPhase) {
    guard isActive else { return }
    self.phase = phase
    anchor.isScrolling = isScrolling
    if phase == .tracking || phase == .interacting {
      invalidateRequests()
      userScrollPending = true
      intent = .history
      // Native interaction establishes the viewport even if initial positioning was deferred.
      hasPositionedHistory = true
      anchor.cancel()
      conversation.rememberReadingPosition(scroll.captureReadingPosition())
    }
    if phase == .animating { userScrollPending = false }
    guard phase == .idle else { return }
    // Layout and restoration can report idle again without another user gesture.
    let didScroll = userScrollPending
    userScrollPending = false
    guard hasPositionedHistory else { return }
    if didScroll, !followsBottom, metrics?.isNearTop == true, conversation.hasEarlierMessages {
      loadEarlierMessages()
    } else if !isAwayFromBottom {
      reachedBottom()
    } else if !followsBottom {
      saveReadingPosition()
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
    if hasPositionedHistory, followsBottom, !isScrolling, metrics.isAwayFromBottom,
      metrics.height != oldHeight
    {
      positionAtBottom()
    }
  }

  func loadEarlierMessages() {
    guard isActive, hasPositionedHistory, !isScrolling, conversation.hasEarlierMessages,
      !isLoadingEarlier, !conversation.isLoadingEarlier, expansionTask == nil
    else { return }
    intent = .history
    saveReadingPosition()
    if let position = conversation.readingPosition { anchor.preserve(position) }
    isLoadingEarlier = true
    earlierExpansionFinished = false
    let requestID = UUID()
    earlierRequestID = requestID
    let generation = requestGeneration
    expansionTask = Task { [weak self] in
      guard let self else { return }
      defer { if requestGeneration == generation { expansionTask = nil } }
      await conversation.loadEarlierMessages()
      guard isActive, earlierRequestID == requestID else { return }
      earlierExpansionFinished = true
      finishEarlierLoadingIfPresented()
      if canContinue(generation), !isScrolling, !followsBottom,
        let position = conversation.readingPosition
      {
        anchor.preserve(position)
      }
    }
  }

  func rowsPresented(firstItemID: String?) {
    presentedFirstItemID = firstItemID
    finishEarlierLoadingIfPresented()
  }

  private func finishEarlierLoadingIfPresented() {
    // Preparing the projection finishes before the native collection commits its measured rows.
    guard isLoadingEarlier, earlierExpansionFinished,
      presentedFirstItemID == conversation.visibleItems.first?.id
    else { return }
    isLoadingEarlier = false
    earlierRequestID = nil
  }

  private func viewportChanged() {
    guard isActive, hasPositionedHistory, !isScrolling else { return }
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
    if let position = anchor.preservedPosition ?? scroll.captureReadingPosition() {
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

  private func cancelSendTransition() {
    guard sendTransition.isActive else { return }
    sendTransition.cancel()
    phase = .idle
    anchor.isScrolling = false
  }

  private func canContinue(_ generation: UUID) -> Bool {
    isActive && !Task.isCancelled && requestGeneration == generation
  }
}
