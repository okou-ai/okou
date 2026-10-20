import ChatDomain
import SwiftUI
import UIKit

/// A dedicated native text view supports selections across the message's layout blocks.
struct MessageTextSelectionSheet: View {
  let text: String
  var message: ChatMessage? = nil
  var quote: ((ChatFeedbackSelection) -> Void)? = nil
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      MessageSelectionTextView(text: text, message: message, quote: quote)
        .navigationTitle("Select Text")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .confirmationAction) {
            Button("Done", systemImage: "checkmark") { dismiss() }
          }
        }
    }
    .presentationDetents([.large])
    .presentationDragIndicator(.visible)
  }
}

private struct MessageSelectionTextView: UIViewRepresentable {
  let text: String
  let message: ChatMessage?
  let quote: ((ChatFeedbackSelection) -> Void)?

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  func makeUIView(context: Context) -> UITextView {
    let view = UITextView()
    view.delegate = context.coordinator
    view.backgroundColor = .clear
    view.font = .preferredFont(forTextStyle: .body)
    view.textColor = .label
    view.adjustsFontForContentSizeCategory = true
    view.isEditable = false
    view.isSelectable = true
    view.textContainerInset = UIEdgeInsets(top: 16, left: 20, bottom: 24, right: 20)
    view.textContainer.lineFragmentPadding = 0
    view.accessibilityIdentifier = "message-selection-text"
    return view
  }

  func updateUIView(_ view: UITextView, context: Context) {
    context.coordinator.input = self
    // Parent updates must not replace the native selection while the reader adjusts it.
    if view.text != text { view.text = text }
  }

  static func dismantleUIView(_ view: UITextView, coordinator: Coordinator) { view.delegate = nil }

  final class Coordinator: NSObject, UITextViewDelegate {
    var input: MessageSelectionTextView
    init(_ input: MessageSelectionTextView) { self.input = input }

    func textView(
      _ textView: UITextView, editMenuForTextIn range: NSRange,
      suggestedActions: [UIMenuElement]
    ) -> UIMenu? {
      guard let message = input.message, input.quote != nil, textView.text == message.text,
        let selection = ChatFeedbackSelection(message: message, range: range)
      else { return UIMenu(children: suggestedActions) }
      let action = UIAction(title: "Quote", image: UIImage(systemName: "text.quote")) {
        [weak self, weak textView] _ in
        guard let self, let textView, textView.text == selection.text,
          textView.selectedRange == range
        else { return }
        input.quote?(selection)
      }
      return UIMenu(children: [action] + suggestedActions)
    }
  }
}
