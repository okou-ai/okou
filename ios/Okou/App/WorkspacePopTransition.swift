import UIKit

/// The pan supplies the fraction. UIKit coordinates cancellation, appearance and keyboard changes.
final class WorkspacePopTransition: UIPercentDrivenInteractiveTransition,
  UIViewControllerAnimatedTransitioning
{
  private var animator: UIViewPropertyAnimator?

  func transitionDuration(using transitionContext: (any UIViewControllerContextTransitioning)?)
    -> TimeInterval
  {
    0.25
  }

  func animateTransition(using transitionContext: any UIViewControllerContextTransitioning) {
    interruptibleAnimator(using: transitionContext).startAnimation()
  }

  func interruptibleAnimator(using context: any UIViewControllerContextTransitioning)
    -> any UIViewImplicitlyAnimating
  {
    if let animator { return animator }
    let animator = UIViewPropertyAnimator(
      duration: transitionDuration(using: context), curve: .linear)
    self.animator = animator
    guard let chat = context.view(forKey: .from), let list = context.view(forKey: .to),
      let listController = context.viewController(forKey: .to)
    else {
      animator.addCompletion { [weak self] _ in
        self?.animator = nil
        context.completeTransition(false)
      }
      return animator
    }

    let container = context.containerView
    let chatFrame = chat.frame
    let listFrame = context.finalFrame(for: listController)
    let width = container.bounds.width
    let offset = container.effectiveUserInterfaceLayoutDirection == .rightToLeft ? -width : width
    let fades = UIAccessibility.isReduceMotionEnabled
    let chatAlpha = chat.alpha
    container.insertSubview(list, belowSubview: chat)
    list.frame = fades ? listFrame : listFrame.offsetBy(dx: -offset / 3, dy: 0)

    animator.addAnimations {
      if fades {
        chat.alpha = 0
      } else {
        chat.frame = chatFrame.offsetBy(dx: offset, dy: 0)
        list.frame = listFrame
      }
    }
    animator.addCompletion { [weak self] _ in
      let completed = !context.transitionWasCancelled
      if !completed { list.removeFromSuperview() }
      context.completeTransition(completed)
      // Restore the retained hosts in their final hierarchy, including their accessibility frames.
      chat.frame = chatFrame
      chat.alpha = chatAlpha
      list.frame = listFrame
      if !completed {
        chat.setNeedsLayout()
        chat.layoutIfNeeded()
      }
      self?.animator = nil
    }
    return animator
  }
}
