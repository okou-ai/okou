import UIKit

/// Commands use mounted native editors; UIKit owns selection, undo and marked text.
@MainActor
final class ComposerEditor {
  private struct Input {
    weak var view: ComposerTextView?
    let order: Int
    let canAppend: Bool
    let isCurrent: @MainActor () -> Bool
    let searchableRanges: @MainActor () -> [NSRange]?
    let focusRequested: @MainActor () -> Void
  }
  private var inputs: [ObjectIdentifier: Input] = [:]

  private var mounted: [Input] {
    inputs.values.filter {
      $0.isCurrent() && $0.view?.window != nil && $0.view?.isEditable == true
    }.sorted { $0.order < $1.order }
  }

  var view: ComposerTextView? { mounted.last(where: \.canAppend)?.view }

  func register(
    _ view: ComposerTextView, order: Int, canAppend: Bool,
    isCurrent: @escaping @MainActor () -> Bool,
    searchableRanges: @escaping @MainActor () -> [NSRange]?,
    focusRequested: @escaping @MainActor () -> Void
  ) {
    inputs[ObjectIdentifier(view)] = Input(
      view: view, order: order, canAppend: canAppend, isCurrent: isCurrent,
      searchableRanges: searchableRanges, focusRequested: focusRequested)
  }

  func unregister(_ view: ComposerTextView) { inputs.removeValue(forKey: ObjectIdentifier(view)) }

  func dismissKeyboard() {
    for input in inputs.values where input.isCurrent() {
      input.view?.setFocused(false)
    }
  }

  func selectOrAppendText(_ value: String) {
    let prompt = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !prompt.isEmpty else { return }
    mounted.first(where: { $0.view?.isFirstResponder == true })?.view?.unmarkText()
    let current = mounted
    for input in current {
      guard let view = input.view,
        let range = match(prompt, in: view.text ?? "", ranges: input.searchableRanges())
      else { continue }
      guard view.becomeFirstResponder() else { return }
      view.setFocused(true)
      view.selectedRange = range
      input.focusRequested()
      view.scrollRangeToVisible(range)
      return
    }
    guard let target = current.last(where: \.canAppend), let view = target.view,
      view.becomeFirstResponder()
    else { return }
    view.setFocused(true)
    view.unmarkText()
    let text = view.text ?? ""
    view.selectedRange = NSRange(location: (text as NSString).length, length: 0)
    let lastParagraph = text.components(separatedBy: "\n").last ?? ""
    let separator = lastParagraph.trimmingCharacters(in: .whitespaces).isEmpty ? "" : "\n"
    view.insertText(separator + prompt)
    target.focusRequested()
    view.scrollRangeToVisible(view.selectedRange)
  }

  private func match(_ prompt: String, in text: String, ranges: [NSRange]?) -> NSRange? {
    let string = text as NSString
    for range in ranges ?? [NSRange(location: 0, length: string.length)] {
      guard range.location >= 0, range.length >= 0, range.location <= string.length,
        range.length <= string.length - range.location
      else { continue }
      var location = range.location
      // Like ProseMirror, search contiguous text within one paragraph; references
      // and native newlines separate runs rather than creating an artificial match.
      for paragraph in string.substring(with: range).components(separatedBy: "\n") {
        let found = (paragraph as NSString).range(of: prompt, options: .literal)
        if found.location != NSNotFound {
          return NSRange(location: location + found.location, length: found.length)
        }
        location += (paragraph as NSString).length + 1
      }
    }
    return nil
  }
}
