import Observation
import SwiftUI

/// Keeps a local send on one native viewport transition, after its measured row is ready.
@MainActor @Observable
final class ConversationSendTransition {
  private static let flightDuration: CFTimeInterval = 0.2
  private static let flightCurve = UnitCurve.bezier(
    startControlPoint: UnitPoint(x: 0.2, y: 0.4),
    endControlPoint: UnitPoint(x: 0.4, y: 1))
  private(set) var hidesBubbleID: String?
  @ObservationIgnored private var flight: SendMotionFlight?
  @ObservationIgnored private var flightStartedAt: CFTimeInterval = 0
  @ObservationIgnored private var flightFraction: CGFloat = 0
  @ObservationIgnored private var flightHasMeasuredRow = false
  @ObservationIgnored private var projectedContentHeight: CGFloat?
  @ObservationIgnored private var viewportFractionOrigin: CGFloat = 0
  private(set) var composerAnimation = Animation.easeInOut(duration: 0.22)
  @ObservationIgnored private(set) var messageID: String?
  @ObservationIgnored private(set) var isAnimating = false
  @ObservationIgnored private weak var collection: UICollectionView?
  @ObservationIgnored private weak var arrivingView: UIView?
  @ObservationIgnored private var keyboardObserver: NSObjectProtocol?
  @ObservationIgnored private var offset = CGPoint.zero
  @ObservationIgnored private var target: CGFloat?
  @ObservationIgnored private var deadline: CFTimeInterval = 0
  @ObservationIgnored private var curve: UInt = 0
  @ObservationIgnored private var displayLink: CADisplayLink?
  @ObservationIgnored private var animationOrigin = CGPoint.zero
  @ObservationIgnored private var alphaOrigin: CGFloat = 0
  @ObservationIgnored private var duration: CFTimeInterval = 0
  @ObservationIgnored private var elapsed: CFTimeInterval = 0
  @ObservationIgnored private var previousFrame: CFTimeInterval?
  @ObservationIgnored private var updatesOffset = false
  @ObservationIgnored private var reduceMotion = false
  @ObservationIgnored var didBegin: (() -> Void)?
  @ObservationIgnored var didFinish: (() -> Void)?
  @ObservationIgnored var didEnd: (() -> Void)?

  var isActive: Bool { messageID != nil }

  func attach(_ collection: UICollectionView) {
    self.collection = collection
  }

  func begin(messageID: String, reduceMotion: Bool, sourceView: ComposerTextView? = nil) {
    cancel()
    guard let collection else { return }
    self.messageID = messageID
    self.reduceMotion = reduceMotion
    if !reduceMotion,
      let sourceView, !sourceView.text.isEmpty
    {
      flight = SendMotionFlight(source: sourceView)
      if flight != nil {
        hidesBubbleID = messageID
      }
    }
    offset = collection.contentOffset
    curve = 0
    composerAnimation =
      flight != nil
      ? .timingCurve(0.2, 0.4, 0.4, 1, duration: Self.flightDuration)
      : .easeInOut(duration: 0.22)
    didBegin?()
    if flight?.messageFrame != nil {
      isAnimating = true
      animateToBottom()
    }
    keyboardObserver = NotificationCenter.default.addObserver(
      forName: UIResponder.keyboardWillChangeFrameNotification, object: nil, queue: .main
    ) { [weak self] notification in
      guard
        let duration =
          (notification.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?
          .doubleValue,
        let curve =
          (notification.userInfo?[UIResponder.keyboardAnimationCurveUserInfoKey] as? NSNumber)?
          .uintValue
      else { return }
      MainActor.assumeIsolated { self?.keyboardWillChange(duration: duration, curve: curve) }
    }
  }

  func registerBubble(messageID: String, view: UIView) {
    guard self.messageID == messageID, view.window != nil else { return }
    flight?.destination = view
  }

  func projectFlight(insertionY: CGFloat, topSpacing: CGFloat) {
    guard let flight, let collection else { return }
    let height = flight.measuredBubbleSize(width: collection.bounds.width).height
    flight.collection = collection
    flight.messageFrame = CGRect(
      x: 0, y: insertionY + topSpacing,
      width: collection.bounds.width, height: height)
    projectedContentHeight = insertionY + topSpacing + height + 93
  }

  private func keyboardWillChange(duration: Double, curve: UInt) {
    guard isActive else { return }
    if flight != nil {
      // Keep the bubble clock while native keyboard dismissal changes the viewport.
      deadline = max(deadline, CACurrentMediaTime() + duration)
      layoutDidChange()
      return
    }
    // Later zero-duration keyboard geometry must not cut a visible send short.
    deadline = max(deadline, CACurrentMediaTime() + duration)
    self.curve = curve
    switch curve {
    case 0: composerAnimation = .easeInOut(duration: duration)
    case 1: composerAnimation = .easeIn(duration: duration)
    case 2: composerAnimation = .easeOut(duration: duration)
    case 3: composerAnimation = .linear(duration: duration)
    default:
      composerAnimation =
        duration == 0 ? .linear(duration: 0) : .interpolatingSpring(duration: duration, bounce: 0)
    }
    if isAnimating {
      self.duration = max(self.duration, elapsed + duration)
      target = nil
      animateToBottom()
    }
  }

  /// Native keyboard compensation owns the viewport until the measured row commits.
  func layoutDidChange() {
    guard isActive else { return }
    preserveOffset()
    if isAnimating {
      animateToBottom()
    }
  }

  func preserveOffset() {
    guard let collection, isActive, !updatesOffset else { return }
    guard isAnimating, flight == nil || flightHasMeasuredRow else {
      offset = collection.contentOffset
      return
    }
    // After handoff, only our display-frame updates advance the send's viewport.
    guard abs(collection.contentOffset.y - offset.y) > 0.5 else { return }
    updatesOffset = true
    defer { updatesOffset = false }
    UIView.performWithoutAnimation { collection.setContentOffset(offset, animated: false) }
  }

  func presentIfReady(in ids: Set<String>, arrivingView: UIView?, messageFrame: CGRect? = nil) {
    if let messageID, ids.contains(messageID) {
      flight?.collection = collection
      flight?.messageFrame = messageFrame
    }
    if let messageID, ids.contains(messageID), flight != nil, !flightHasMeasuredRow {
      flightHasMeasuredRow = true
      projectedContentHeight = nil
      self.arrivingView = arrivingView
      isAnimating = true
      animateToBottom()
      return
    }
    guard let messageID, ids.contains(messageID), !isAnimating else {
      layoutDidChange()
      return
    }
    layoutDidChange()
    self.arrivingView = arrivingView
    UIView.performWithoutAnimation { arrivingView?.alpha = 0 }
    isAnimating = true
    // Measurement can consume most of a keyboard transition. The arriving row
    // still needs a visible transition instead of a nearly zero-duration jump.
    duration = max(0.22, deadline - CACurrentMediaTime())
    elapsed = 0
    animateToBottom()
  }

  /// Structural/height updates join the running send from its presented position.
  func prepareForSnapshot() {
    guard isAnimating else { return }
    if flight != nil {
      // Snapshot work can change the destination, never the flight's elapsed time.
      if flightHasMeasuredRow { target = nil }
      return
    }
    displayLink?.invalidate()
    displayLink = nil
    previousFrame = nil
    target = nil
  }

  private func animateToBottom() {
    guard let collection, isActive, isAnimating else { return }
    let insets = collection.adjustedContentInset
    let y = max(
      -insets.top,
      (projectedContentHeight ?? collection.contentSize.height)
        - collection.bounds.height + insets.bottom)
    if let target, abs(target - y) <= 0.5 { return }
    target = y
    animationOrigin = offset
    alphaOrigin = arrivingView?.alpha ?? 1
    if flight != nil {
      viewportFractionOrigin = flightFraction
    } else {
      duration = max(0, duration - elapsed)
      elapsed = 0
    }
    if reduceMotion {
      presentFrame(fraction: 1, in: collection, target: y)
      if CACurrentMediaTime() >= deadline {
        finish()
        return
      }
    }
    // Composer/keyboard geometry can change on every frame. Retarget the
    // current clock; only an actual snapshot pauses it.
    guard displayLink == nil else { return }
    // Starting the clock on its first display callback excludes snapshot work
    // before any frame can be presented. UIKit animation completions cannot
    // finish the viewport ahead of this clock.
    let frameTarget = ConversationSendFrameTarget(transition: self)
    let link = CADisplayLink(
      target: frameTarget, selector: #selector(ConversationSendFrameTarget.tick(_:)))
    displayLink = link
    link.add(to: .main, forMode: .common)
  }

  fileprivate func advanceFrame(_ link: CADisplayLink) {
    guard displayLink === link, let collection, let target, isAnimating else { return }
    if flight != nil {
      if flightStartedAt == 0 {
        flightStartedAt = link.timestamp
      }
      let progress = min(1, max(0, (link.timestamp - flightStartedAt) / Self.flightDuration))
      flightFraction = CGFloat(Self.flightCurve.value(at: progress))
      let viewportFraction: CGFloat =
        progress >= 1
        ? 1
        : min(
          1,
          max(
            0,
            (flightFraction - viewportFractionOrigin) / max(0.0001, 1 - viewportFractionOrigin)))
      presentFrame(
        fraction: viewportFraction, in: collection, target: target,
        flightFraction: flightFraction)
      guard displayLink === link, self.target == target else { return }
      if progress >= 1, flightHasMeasuredRow, CACurrentMediaTime() >= deadline { finish() }
      return
    }
    if let previousFrame {
      elapsed += max(0, link.timestamp - previousFrame)
    }
    previousFrame = link.timestamp
    let progress = reduceMotion || duration == 0 ? 1 : min(1, elapsed / duration)
    let value: Double
    if progress >= 1 {
      value = 1
    } else {
      value =
        switch curve {
        case 0: UnitCurve.easeInOut.value(at: progress)
        case 1: UnitCurve.easeIn.value(at: progress)
        case 2: UnitCurve.easeOut.value(at: progress)
        case 3: progress
        default: Spring(duration: duration, bounce: 0).value(target: 1, time: elapsed)
        }
    }
    presentFrame(
      fraction: CGFloat(min(1, max(0, value))),
      in: collection, target: target)
    guard displayLink === link, self.target == target else { return }
    if progress >= 1, CACurrentMediaTime() >= deadline { finish() }
  }

  private func presentFrame(
    fraction: CGFloat, in collection: UICollectionView, target: CGFloat,
    flightFraction: CGFloat? = nil
  ) {
    if let flight, !flightHasMeasuredRow {
      // The pending row is not in the collection yet. Only the overlay may move;
      // scrolling to its projected height would scroll past the existing cells.
      UIView.performWithoutAnimation {
        flight.present(
          fraction: flightFraction ?? fraction,
          remainingScroll: target - collection.contentOffset.y)
      }
      return
    }
    let y = animationOrigin.y + (target - animationOrigin.y) * fraction
    let alpha = alphaOrigin + (1 - alphaOrigin) * fraction
    // Move the native viewport every frame so collection reuse keeps the visible rows mounted.
    offset = CGPoint(x: animationOrigin.x, y: y)
    UIView.performWithoutAnimation {
      arrivingView?.alpha = flight == nil ? alpha : 1
      collection.setContentOffset(offset, animated: false)
      flight?.present(fraction: flightFraction ?? fraction, remainingScroll: target - offset.y)
    }
  }

  func cancel() {
    let wasActive = isActive
    messageID = nil
    isAnimating = false
    target = nil
    deadline = 0
    if let keyboardObserver { NotificationCenter.default.removeObserver(keyboardObserver) }
    keyboardObserver = nil
    displayLink?.invalidate()
    displayLink = nil
    previousFrame = nil
    duration = 0
    elapsed = 0
    UIView.performWithoutAnimation { arrivingView?.alpha = 1 }
    arrivingView = nil
    flight?.remove()
    flight = nil
    flightStartedAt = 0
    flightFraction = 0
    flightHasMeasuredRow = false
    projectedContentHeight = nil
    viewportFractionOrigin = 0
    hidesBubbleID = nil
    if wasActive { didEnd?() }
  }

  private func finish() {
    cancel()
    didFinish?()
  }
}

@MainActor
private final class ConversationSendFrameTarget: NSObject {
  private weak var transition: ConversationSendTransition?
  init(transition: ConversationSendTransition) { self.transition = transition }
  @objc func tick(_ link: CADisplayLink) {
    guard let transition else {
      link.invalidate()
      return
    }
    transition.advanceFrame(link)
  }
}
