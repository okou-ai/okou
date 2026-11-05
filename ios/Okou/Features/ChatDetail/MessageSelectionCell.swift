import ChatDomain
import UIKit

/// Extend the rendered text's native edit menu through its public responder chain.
final class MessageSelectionCell: UICollectionViewCell {
  private var prefetchedContent: UIView?
  private var recycleContent: ((UIView) -> Void)?
  var representedRowID: String?
  var message: ChatMessage?
  var quote: ((ChatFeedbackSelection) -> Void)?

  isolated deinit {
    prefetchedContent?.removeFromSuperview()
  }

  override func prepareForReuse() {
    super.prepareForReuse()
    releaseContent()
    representedRowID = nil
    message = nil
    quote = nil
  }

  func setMessageConfiguration(_ configuration: some UIContentConfiguration) {
    releaseContent()
    contentConfiguration = configuration
  }

  func showPrefetchedContent(_ view: UIView, recycle: ((UIView) -> Void)? = nil) {
    releaseContent()
    contentConfiguration = nil
    prefetchedContent = view
    recycleContent = recycle
    attachPrefetchedContent()
  }

  private func releaseContent() {
    guard let view = prefetchedContent else { return }
    let recycle = recycleContent
    prefetchedContent = nil
    recycleContent = nil
    view.endEditing(true)
    if let recycle { recycle(view) } else { view.removeFromSuperview() }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    attachPrefetchedContent()
  }

  private func attachPrefetchedContent() {
    guard window != nil, let view = prefetchedContent, view.superview !== contentView else {
      return
    }
    // Keep the host in its current window until the cell can take it.
    contentView.addSubview(view)
    view.frame = contentView.bounds
    view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.isUserInteractionEnabled = true
    view.accessibilityElementsHidden = false
  }

  override func buildMenu(with builder: any UIMenuBuilder) {
    super.buildMenu(with: builder)
    guard let action = quoteAction() else { return }
    builder.insertChild(
      UIMenu(options: .displayInline, children: [action]), atEndOfMenu: .standardEdit)
  }

  func quoteAction() -> UIAction? {
    guard quote != nil, let (input, selection) = selectedPassage() else { return nil }
    return UIAction(title: "Quote", image: UIImage(systemName: "text.quote")) {
      [weak self, weak input] _ in
      guard let self, let input, input.window != nil,
        let (currentInput, current) = selectedPassage(), currentInput === input,
        current == selection
      else { return }
      input.selectedTextRange = nil
      input.resignFirstResponder()
      quote?(selection)
    }
  }

  private func selectedPassage() -> ((UIView & UITextInput), ChatFeedbackSelection)? {
    guard let message, let input = selectedInput(in: contentView),
      let selected = input.selectedTextRange, !selected.isEmpty,
      let document = input.textRange(from: input.beginningOfDocument, to: input.endOfDocument),
      let visibleText = input.text(in: document),
      let selection = ChatFeedbackSelection(
        message: message,
        range: NSRange(
          location: input.offset(from: input.beginningOfDocument, to: selected.start),
          length: input.offset(from: selected.start, to: selected.end)),
        visibleText: visibleText)
    else { return nil }
    return (input, selection)
  }

  private func selectedInput(in view: UIView) -> (UIView & UITextInput)? {
    if view.isFirstResponder, let input = view as? (UIView & UITextInput) { return input }
    for child in view.subviews {
      if let input = selectedInput(in: child) { return input }
    }
    return nil
  }
}
