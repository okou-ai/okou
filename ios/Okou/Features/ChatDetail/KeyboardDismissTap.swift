import SwiftUI

/// A tap anywhere in the transcript puts the keyboard away, so the composer folds back as in
/// Messages and ChatGPT. It never takes the tap from what is under it: links, cards and text
/// selection still get it.
final class KeyboardDismissTap: NSObject, UIGestureRecognizerDelegate {
  init(on view: UIView) {
    super.init()
    let tap = UITapGestureRecognizer(target: self, action: #selector(dismiss))
    tap.cancelsTouchesInView = false
    tap.delegate = self
    view.addGestureRecognizer(tap)
  }

  @objc private func dismiss() {
    // The transcript's text selection must keep its own first responder.
    UIApplication.shared.sendAction(
      #selector(ComposerTextView.dismissComposerKeyboard), to: nil, from: self, for: nil)
  }

  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer,
    shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
  ) -> Bool { true }
}
