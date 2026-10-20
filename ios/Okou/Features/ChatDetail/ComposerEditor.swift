import UIKit

/// Commands target the mounted native editor so selection, undo and marked
/// text remain UIKit's responsibility. This never submits or changes model settings.
@MainActor
final class ComposerEditor {
  weak var view: ComposerTextView?

  func selectOrAppendText(_ value: String) {
    let prompt = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !prompt.isEmpty, let view, view.isEditable else { return }
    view.setFocused(true)
    view.unmarkText()
    let text = view.text ?? ""
    // ProseMirror searches contiguous text nodes within a textblock. A native
    // newline separates textblocks and cannot participate in an existing match.
    var location = 0
    for paragraph in text.components(separatedBy: "\n") {
      let match = (paragraph as NSString).range(of: prompt, options: .literal)
      if match.location != NSNotFound {
        view.selectedRange = NSRange(location: location + match.location, length: match.length)
        view.scrollRangeToVisible(view.selectedRange)
        return
      }
      location += (paragraph as NSString).length + 1
    }
    view.selectedRange = NSRange(location: (text as NSString).length, length: 0)
    let lastParagraph = text.components(separatedBy: "\n").last ?? ""
    let separator = lastParagraph.trimmingCharacters(in: .whitespaces).isEmpty ? "" : "\n"
    view.insertText(separator + prompt)
    view.scrollRangeToVisible(view.selectedRange)
  }
}
