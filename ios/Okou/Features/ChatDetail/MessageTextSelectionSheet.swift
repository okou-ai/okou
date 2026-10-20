import SwiftUI
import UIKit

/// A dedicated native text view supports selections across the message's layout blocks.
struct MessageTextSelectionSheet: View {
  let text: String
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      MessageSelectionTextView(text: text)
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

  func makeUIView(context: Context) -> UITextView {
    let view = UITextView()
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
    // Parent updates must not replace the native selection while the reader adjusts it.
    if view.text != text { view.text = text }
  }
}
