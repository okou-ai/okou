import UIKit

/// Keeps the live page frames at the finger's actual position while UIKit owns the stack and focus.
@MainActor
final class WorkspacePopTransition: NSObject, UIViewControllerInteractiveTransitioning,
  UIViewControllerAnimatedTransitioning
{
  private let didEnd: () -> Void
  private var context: (any UIViewControllerContextTransitioning)?
  private var chatFrame = CGRect.zero
  private var listFrame = CGRect.zero
  private var offset: CGFloat = 0
  private var progress: CGFloat = 0
  private var completes: Bool?
  private let fades = UIAccessibility.isReduceMotionEnabled

  init(didEnd: @escaping () -> Void) {
    self.didEnd = didEnd
  }

  func transitionDuration(using transitionContext: (any UIViewControllerContextTransitioning)?)
    -> TimeInterval
  {
    0.25
  }

  func animateTransition(using context: any UIViewControllerContextTransitioning) {
    completes = true
    startInteractiveTransition(context)
  }

  func startInteractiveTransition(_ context: any UIViewControllerContextTransitioning) {
    guard let chat = context.view(forKey: .from), let list = context.view(forKey: .to),
      let listController = context.viewController(forKey: .to)
    else {
      didEnd()
      if context.isInteractive { context.cancelInteractiveTransition() }
      context.completeTransition(false)
      return
    }
    self.context = context
    let container = context.containerView
    chatFrame = chat.frame
    listFrame = context.finalFrame(for: listController)
    offset =
      container.effectiveUserInterfaceLayoutDirection == .rightToLeft
      ? -container.bounds.width : container.bounds.width
    container.insertSubview(list, belowSubview: chat)
    list.frame = listFrame
    update(progress)
    if let completes { end(completes: completes) }
  }

  func update(_ fraction: CGFloat) {
    progress = fraction
    guard let context else { return }
    if context.isInteractive { context.updateInteractiveTransition(fraction) }
    positionPages(at: fraction, in: context)
  }

  private func positionPages(
    at fraction: CGFloat, in context: any UIViewControllerContextTransitioning
  ) {
    if fades {
      context.view(forKey: .from)?.alpha = 1 - fraction
    } else {
      context.view(forKey: .from)?.frame = chatFrame.offsetBy(dx: offset * fraction, dy: 0)
      context.view(forKey: .to)?.frame = listFrame.offsetBy(dx: -offset * (1 - fraction) / 3, dy: 0)
    }
  }

  func end(completes: Bool) {
    self.completes = completes
    guard let context else { return }  // UIKit may supply the context after a very short drag ends.
    self.context = nil
    if context.isInteractive {
      if completes {
        context.finishInteractiveTransition()
      } else {
        context.cancelInteractiveTransition()
      }
    }
    let target: CGFloat = completes ? 1 : 0
    let duration = transitionDuration(using: context) * abs(target - progress)
    UIView.animate(withDuration: duration, delay: 0, options: .curveEaseOut) {
      self.positionPages(at: target, in: context)
    } completion: { _ in
      let chat = context.view(forKey: .from)
      let list = context.view(forKey: .to)
      if !completes { list?.removeFromSuperview() }
      self.didEnd()
      context.completeTransition(completes)
      chat?.frame = self.chatFrame
      chat?.alpha = 1
      list?.frame = self.listFrame
      if !completes { UIAccessibility.post(notification: .layoutChanged, argument: nil) }
    }
  }
}
