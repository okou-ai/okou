import ChatDomain
import UIKit

/// Extend the rendered text's native edit menu through its public responder chain.
final class MessageSelectionCell: UICollectionViewCell {
  var message: ChatMessage?
  var quote: ((ChatFeedbackSelection) -> Void)?

  override func prepareForReuse() {
    super.prepareForReuse()
    message = nil
    quote = nil
  }

  override func buildMenu(with builder: any UIMenuBuilder) {
    super.buildMenu(with: builder)
    guard let action = quoteAction() else { return }
    builder.insertChild(
      UIMenu(options: .displayInline, children: [action]), atStartOfMenu: .standardEdit)
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
