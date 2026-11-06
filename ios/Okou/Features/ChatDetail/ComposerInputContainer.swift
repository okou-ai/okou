import UIKit

final class ComposerInputContainer: UIView {
  let textView = ComposerTextView()
  private let expansionButton = UIButton(type: .custom)

  var expandsOnTap: Bool {
    get { !expansionButton.isHidden }
    set { expansionButton.isHidden = !newValue }
  }

  init() {
    super.init(frame: .zero)
    addSubview(textView)
    // A sibling control owns the compact activation tap so UITextView cannot
    // subsequently replace the end selection with the original tap position.
    expansionButton.isHidden = true
    expansionButton.isAccessibilityElement = false
    expansionButton.accessibilityIdentifier = "expand-message-input"
    expansionButton.addAction(
      UIAction { [weak self] _ in self?.expand() }, for: .touchUpInside)
    addSubview(expansionButton)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func layoutSubviews() {
    super.layoutSubviews()
    textView.frame = bounds
    expansionButton.frame = bounds
  }

  private func expand() {
    guard expandsOnTap, textView.isCurrent(), textView.isEditable,
      textView.becomeFirstResponder()
    else { return }
    expandsOnTap = false
    textView.setFocused(true)
    textView.selectedRange = NSRange(location: textView.textStorage.length, length: 0)
    textView.scrollRangeToVisible(textView.selectedRange)
  }
}
