import Observation
import SwiftUI

/// Keeps a local send on one native viewport transition, after its measured row is ready.
@MainActor @Observable
final class ConversationSendTransition {
  private(set) var composerAnimation = Animation.easeInOut(duration: 0.22)
  @ObservationIgnored private(set) var messageID: String?
  @ObservationIgnored private(set) var isAnimating = false
  @ObservationIgnored private weak var collection: UICollectionView?
  @ObservationIgnored private weak var arrivingView: UIView?
  @ObservationIgnored private var keyboardObserver: NSObjectProtocol?
  @ObservationIgnored private var offset = CGPoint.zero
  @ObservationIgnored private var target: CGFloat?
  @ObservationIgnored private var deadline: CFTimeInterval = 0
  @ObservationIgnored private var options = UIView.AnimationOptions.curveEaseInOut
  @ObservationIgnored private var animator: UIViewPropertyAnimator?
  @ObservationIgnored private var displayLink: CADisplayLink?
  private let progress = UIView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
  @ObservationIgnored private var animationOrigin = CGPoint.zero
  @ObservationIgnored private var updatesOffset = false
  @ObservationIgnored private var generation = UUID()
  @ObservationIgnored private var reduceMotion = false
  @ObservationIgnored var didBegin: (() -> Void)?
  @ObservationIgnored var didFinish: (() -> Void)?

  var isActive: Bool { messageID != nil }

  func attach(_ collection: UICollectionView) {
    self.collection = collection
    progress.isUserInteractionEnabled = false
    progress.accessibilityElementsHidden = true
    collection.addSubview(progress)
  }

  func begin(messageID: String, reduceMotion: Bool) {
    cancel()
    guard let collection else { return }
    self.messageID = messageID
    self.reduceMotion = reduceMotion
    offset = collection.contentOffset
    options = .curveEaseInOut
    composerAnimation = .easeInOut(duration: 0.22)
    didBegin?()
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

  private func keyboardWillChange(duration: Double, curve: UInt) {
    guard isActive else { return }
    // Later zero-duration keyboard geometry must not cut a visible send short.
    deadline = max(deadline, CACurrentMediaTime() + duration)
    options = UIView.AnimationOptions(rawValue: curve << 16)
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
      target = nil
      animateToBottom()
    }
  }

  /// Before insertion, keyboard/composer layout must not scroll toward the old footer.
  func layoutDidChange() {
    guard isActive else { return }
    preserveOffset()
    if isAnimating {
      animateToBottom()
    }
  }

  func preserveOffset() {
    guard let collection, isActive, !updatesOffset else { return }
    // UIKit can preserve its old bottom during a snapshot or keyboard layout.
    // Only our display-frame updates advance this send's viewport.
    guard abs(collection.contentOffset.y - offset.y) > 0.5 else { return }
    updatesOffset = true
    defer { updatesOffset = false }
    UIView.performWithoutAnimation { collection.setContentOffset(offset, animated: false) }
  }

  func presentIfReady(in ids: Set<String>, arrivingView: UIView?) {
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
    deadline = max(deadline, CACurrentMediaTime() + 0.22)
    animateToBottom()
  }

  /// Structural/height updates join the running send from its presented position.
  func prepareForSnapshot() {
    guard isAnimating, animator?.state == .active else { return }
    let alpha = arrivingView?.layer.presentation()?.opacity
    generation = UUID()
    animator?.stopAnimation(true)
    animator = nil
    displayLink?.invalidate()
    displayLink = nil
    target = nil
    UIView.performWithoutAnimation {
      if let alpha { arrivingView?.alpha = CGFloat(alpha) }
    }
  }

  private func animateToBottom() {
    guard let collection, isActive, isAnimating else { return }
    let insets = collection.adjustedContentInset
    let y = max(
      -insets.top, collection.contentSize.height - collection.bounds.height + insets.bottom)
    if let target, abs(target - y) <= 0.5 { return }
    prepareForSnapshot()
    target = y
    animationOrigin = offset
    let generation = UUID()
    self.generation = generation
    if reduceMotion {
      startAnimation(to: y, in: collection, generation: generation)
      return
    }
    // Diffable snapshots can invoke their completion with UIView animations
    // disabled. Start after that synchronous layout transaction has returned.
    DispatchQueue.main.async { [weak self] in
      guard let self, self.generation == generation, isActive, isAnimating else { return }
      startAnimation(to: y, in: collection, generation: generation)
    }
  }

  private func startAnimation(
    to y: CGFloat, in collection: UICollectionView, generation: UUID
  ) {
    let duration = reduceMotion ? 0 : max(0, deadline - CACurrentMediaTime())
    if duration == 0 {
      offset = CGPoint(x: animationOrigin.x, y: y)
      collection.setContentOffset(offset, animated: false)
      arrivingView?.alpha = 1
      finish()
      return
    }
    UIView.performWithoutAnimation { progress.alpha = 0 }
    displayLink?.invalidate()
    let frameTarget = ConversationSendFrameTarget(transition: self)
    let link = CADisplayLink(
      target: frameTarget, selector: #selector(ConversationSendFrameTarget.tick(_:)))
    displayLink = link
    link.add(to: .main, forMode: .common)
    animator = UIViewPropertyAnimator.runningPropertyAnimator(
      withDuration: duration, delay: 0,
      options: options.union(.allowUserInteraction)
    ) {
      self.progress.alpha = 1
      self.arrivingView?.alpha = 1
    } completion: { [weak self] _ in
      guard let self, self.generation == generation, isActive else { return }
      if let target {
        offset = CGPoint(x: animationOrigin.x, y: target)
        collection.setContentOffset(offset, animated: false)
      }
      finish()
    }
  }

  fileprivate func advanceFrame() {
    guard let collection, let target, isAnimating else { return }
    let fraction = CGFloat(progress.layer.presentation()?.opacity ?? 0)
    let y = animationOrigin.y + (target - animationOrigin.y) * min(1, max(0, fraction))
    // Move the native viewport every frame so collection reuse keeps the visible rows mounted.
    offset = CGPoint(x: animationOrigin.x, y: y)
    collection.setContentOffset(offset, animated: false)
  }

  func cancel() {
    generation = UUID()
    messageID = nil
    isAnimating = false
    target = nil
    deadline = 0
    if let keyboardObserver { NotificationCenter.default.removeObserver(keyboardObserver) }
    keyboardObserver = nil
    if animator?.state == .active { animator?.stopAnimation(true) }
    animator = nil
    displayLink?.invalidate()
    displayLink = nil
    arrivingView?.alpha = 1
    arrivingView = nil
  }

  private func finish() {
    messageID = nil
    isAnimating = false
    target = nil
    deadline = 0
    if let keyboardObserver { NotificationCenter.default.removeObserver(keyboardObserver) }
    keyboardObserver = nil
    animator = nil
    displayLink?.invalidate()
    displayLink = nil
    arrivingView = nil
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
    transition.advanceFrame()
  }
}
