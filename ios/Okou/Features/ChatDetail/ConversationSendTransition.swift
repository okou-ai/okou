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
  @ObservationIgnored private var origin = CGPoint.zero
  @ObservationIgnored private var target: CGFloat?
  @ObservationIgnored private var deadline: CFTimeInterval = 0
  @ObservationIgnored private var options = UIView.AnimationOptions.curveEaseInOut
  @ObservationIgnored private var generation = UUID()
  @ObservationIgnored private var reduceMotion = false
  @ObservationIgnored var didBegin: (() -> Void)?
  @ObservationIgnored var didFinish: (() -> Void)?

  var isActive: Bool { messageID != nil }

  func attach(_ collection: UICollectionView) { self.collection = collection }

  func begin(messageID: String, reduceMotion: Bool) {
    cancel()
    guard let collection else { return }
    self.messageID = messageID
    self.reduceMotion = reduceMotion
    origin = collection.contentOffset
    options = .curveEaseInOut
    composerAnimation = .easeInOut(duration: 0.22)
    didBegin?()
    keyboardObserver = NotificationCenter.default.addObserver(
      forName: UIResponder.keyboardWillChangeFrameNotification, object: nil, queue: .main
    ) { [weak self] notification in
      MainActor.assumeIsolated { self?.keyboardWillChange(notification) }
    }
  }

  private func keyboardWillChange(_ notification: Notification) {
    guard isActive else { return }
    guard let duration =
      (notification.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?
      .doubleValue,
      let curve =
      (notification.userInfo?[UIResponder.keyboardAnimationCurveUserInfoKey] as? NSNumber)?
      .uintValue
    else { return }
    deadline = CACurrentMediaTime() + duration
    options = UIView.AnimationOptions(rawValue: curve << 16)
    switch curve {
    case 0: composerAnimation = .easeInOut(duration: duration)
    case 1: composerAnimation = .easeIn(duration: duration)
    case 2: composerAnimation = .easeOut(duration: duration)
    case 3: composerAnimation = .linear(duration: duration)
    default: composerAnimation = .interpolatingSpring(duration: duration, bounce: 0)
    }
    if isAnimating {
      target = nil
      animateToBottom()
    }
  }

  /// Before insertion, keyboard/composer layout must not scroll toward the old footer.
  func layoutDidChange() {
    guard let collection, isActive else { return }
    if isAnimating {
      animateToBottom()
    } else {
      UIView.performWithoutAnimation { collection.setContentOffset(origin, animated: false) }
    }
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
    if deadline <= CACurrentMediaTime() {
      deadline = CACurrentMediaTime() + 0.22
    }
    animateToBottom()
  }

  private func animateToBottom() {
    guard let collection, isActive, isAnimating else { return }
    let insets = collection.adjustedContentInset
    let y = max(
      -insets.top, collection.contentSize.height - collection.bounds.height + insets.bottom)
    guard target != y else { return }
    target = y
    let generation = UUID()
    self.generation = generation
    let duration = reduceMotion ? 0 : max(0, deadline - CACurrentMediaTime())
    UIView.animate(
      withDuration: duration, delay: 0,
      options: options.union([.beginFromCurrentState, .allowUserInteraction])
    ) {
      collection.setContentOffset(CGPoint(x: collection.contentOffset.x, y: y), animated: false)
      self.arrivingView?.alpha = 1
    } completion: { [weak self] _ in
      guard let self, self.generation == generation, isActive else { return }
      finish()
    }
  }

  func cancel() {
    let wasAnimating = isAnimating
    generation = UUID()
    messageID = nil
    isAnimating = false
    target = nil
    deadline = 0
    if let keyboardObserver { NotificationCenter.default.removeObserver(keyboardObserver) }
    keyboardObserver = nil
    arrivingView?.layer.removeAnimation(forKey: "opacity")
    arrivingView?.alpha = 1
    arrivingView = nil
    if wasAnimating, let collection {
      let offset = collection.layer.presentation()?.bounds.origin ?? collection.contentOffset
      collection.layer.removeAnimation(forKey: "bounds")
      UIView.performWithoutAnimation { collection.setContentOffset(offset, animated: false) }
    }
  }

  private func finish() {
    messageID = nil
    isAnimating = false
    target = nil
    deadline = 0
    if let keyboardObserver { NotificationCenter.default.removeObserver(keyboardObserver) }
    keyboardObserver = nil
    arrivingView = nil
    didFinish?()
  }
}
