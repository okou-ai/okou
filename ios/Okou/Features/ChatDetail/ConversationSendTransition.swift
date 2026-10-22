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

  var isActive: Bool { messageID != nil }

  func attach(_ collection: UICollectionView) {
    self.collection = collection
  }

  func begin(messageID: String, reduceMotion: Bool) {
    cancel()
    guard let collection else { return }
    self.messageID = messageID
    self.reduceMotion = reduceMotion
    offset = collection.contentOffset
    curve = 0
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
    duration = max(0.22, deadline - CACurrentMediaTime())
    elapsed = 0
    animateToBottom()
  }

  /// Structural/height updates join the running send from its presented position.
  func prepareForSnapshot() {
    guard isAnimating else { return }
    displayLink?.invalidate()
    displayLink = nil
    previousFrame = nil
    target = nil
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
    alphaOrigin = arrivingView?.alpha ?? 1
    duration = max(0, duration - elapsed)
    elapsed = 0
    if reduceMotion {
      presentFrame(fraction: 1, in: collection, target: y)
      finish()
      return
    }
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
    if let previousFrame {
      elapsed += max(0, link.timestamp - previousFrame)
    }
    previousFrame = link.timestamp
    let progress = duration == 0 ? 1 : min(1, elapsed / duration)
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
    guard displayLink === link else { return }
    if progress >= 1 { finish() }
  }

  private func presentFrame(fraction: CGFloat, in collection: UICollectionView, target: CGFloat) {
    let y = animationOrigin.y + (target - animationOrigin.y) * fraction
    // Move the native viewport every frame so collection reuse keeps the visible rows mounted.
    offset = CGPoint(x: animationOrigin.x, y: y)
    UIView.performWithoutAnimation {
      collection.setContentOffset(offset, animated: false)
      arrivingView?.alpha = alphaOrigin + (1 - alphaOrigin) * fraction
    }
  }

  func cancel() {
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
  }

  private func finish() {
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
    transition.advanceFrame(link)
  }
}
