import UIKit

/// The pan supplies the fraction. UIKit coordinates cancellation, appearance and keyboard changes.
final class WorkspacePopTransition: UIPercentDrivenInteractiveTransition,
  UIViewControllerAnimatedTransitioning
{
  func transitionDuration(using transitionContext: (any UIViewControllerContextTransitioning)?)
    -> TimeInterval
  {
    0.25
  }

  func animateTransition(using transitionContext: any UIViewControllerContextTransitioning) {
    let container = transitionContext.containerView
    guard let chat = transitionContext.view(forKey: .from),
      let list = transitionContext.view(forKey: .to),
      let listController = transitionContext.viewController(forKey: .to)
    else {
      transitionContext.completeTransition(false)
      return
    }
    list.frame = transitionContext.finalFrame(for: listController)
    container.insertSubview(list, belowSubview: chat)
    let width = container.bounds.width
    let offset = container.effectiveUserInterfaceLayoutDirection == .rightToLeft ? -width : width
    let fades = UIAccessibility.isReduceMotionEnabled
    if !fades { list.transform = CGAffineTransform(translationX: -offset / 3, y: 0) }
    UIView.animate(
      withDuration: transitionDuration(using: transitionContext), delay: 0, options: .curveLinear
    ) {
      if fades {
        chat.alpha = 0
      } else {
        chat.transform = CGAffineTransform(translationX: offset, y: 0)
        list.transform = .identity
      }
    } completion: { _ in
      let completed = !transitionContext.transitionWasCancelled
      if !completed { list.removeFromSuperview() }
      chat.transform = .identity
      chat.alpha = 1
      list.transform = .identity
      transitionContext.completeTransition(completed)
    }
  }
}
