import ChatDomain
import Observation
import UIKit

/// Commands use mounted native editors; UIKit owns selection, undo and marked text.
@MainActor @Observable
final class ComposerEditor {
  let workflows = ComposerWorkflowSuggestions()
  private struct Input {
    weak var view: ComposerTextView?
    let blockID: UUID?
    let order: Int
    let canAppend: Bool
    let isCurrent: @MainActor () -> Bool
    let searchableRanges: @MainActor () -> [NSRange]?
    let focusRequested: @MainActor () -> Void
  }
  @ObservationIgnored private var inputs: [ObjectIdentifier: Input] = [:]
  private(set) var mentionQuery: String?
  private(set) var selectedMentionIndex = 0
  var mentionSource: ComposerMentionSource?
  @ObservationIgnored private weak var mentionView: ComposerTextView?
  @ObservationIgnored private var mentionRange: NSRange?
  @ObservationIgnored private var dismissedMention: String?

  var mentionSuggestions: [ComposerMentionSuggestion] {
    mentionQuery.map { mentionSource?.suggestions(for: $0) ?? [] } ?? []
  }

  func updateMention(in view: ComposerTextView, textChanged: Bool = false) {
    guard inputs[ObjectIdentifier(view)]?.isCurrent() == true else { return }
    if textChanged { dismissedMention = nil }
    guard view.isFirstResponder, view.isEditable, view.markedTextRange == nil,
      view.selectedRange.length == 0, view.usesStructuredDocument,
      let range = Self.activeMention(in: view.text ?? "", caret: view.selectedRange.location)
    else {
      if mentionView === view { clearMention() }
      return
    }
    let query = (view.text as NSString).substring(
      with: NSRange(location: range.location + 1, length: range.length - 1))
    let key = "\(ObjectIdentifier(view))-\(range.location)-\(range.length)-\(query)"
    guard key != dismissedMention else { return }
    if mentionQuery != query || mentionView !== view || mentionRange != range {
      selectedMentionIndex = 0
    }
    mentionView = view
    mentionRange = range
    mentionQuery = query
  }

  private static func activeMention(in text: String, caret: Int) -> NSRange? {
    let value = text as NSString
    guard caret >= 0, caret <= value.length else { return nil }
    let before = value.substring(to: caret) as NSString
    guard let expression = try? NSRegularExpression(pattern: #"(?:^|\s)@(\S*)$"#),
      let match = expression.firstMatch(
        in: before as String, range: NSRange(location: 0, length: before.length)),
      NSMaxRange(match.range) == before.length
    else { return nil }
    let query = match.range(at: 1)
    return NSRange(location: query.location - 1, length: query.length + 1)
  }

  func dismissMentions() {
    if let view = mentionView, let range = mentionRange, let query = mentionQuery {
      dismissedMention = "\(ObjectIdentifier(view))-\(range.location)-\(range.length)-\(query)"
    }
    clearMention()
  }

  private func clearMention() {
    mentionView = nil
    mentionRange = nil
    mentionQuery = nil
    selectedMentionIndex = 0
  }

  @discardableResult func handleMentionKey(_ key: String, in view: ComposerTextView) -> Bool {
    guard mentionView === view, view.markedTextRange == nil, !view.isSettlingComposition else {
      return false
    }
    if key == UIKeyCommand.inputEscape, mentionQuery != nil {
      dismissMentions()
      return true
    }
    let suggestions = mentionSuggestions
    guard !suggestions.isEmpty else { return false }
    switch key {
    case UIKeyCommand.inputUpArrow:
      selectedMentionIndex = (selectedMentionIndex + suggestions.count - 1) % suggestions.count
    case UIKeyCommand.inputDownArrow:
      selectedMentionIndex = (selectedMentionIndex + 1) % suggestions.count
    case "\r", "\t": insertMention(suggestions[min(selectedMentionIndex, suggestions.count - 1)])
    default: return false
    }
    return true
  }

  func insertMention(_ suggestion: ComposerMentionSuggestion) {
    guard let view = mentionView, let input = inputs[ObjectIdentifier(view)], input.isCurrent(),
      view.isFirstResponder, view.isEditable, view.markedTextRange == nil,
      !view.isSettlingComposition,
      let range = mentionRange,
      Self.activeMention(in: view.text ?? "", caret: view.selectedRange.location) == range,
      mentionSuggestions.contains(suggestion)
    else { return }
    let insertion = NSMutableAttributedString(
      attributedString: ComposerAttributedDocument.attributed(
        ChatDraftDocument(parts: [suggestion.part])))
    let after = (view.text as NSString).substring(from: NSMaxRange(range))
    if !after.hasPrefix(" ") {
      insertion.append(
        NSAttributedString(string: " ", attributes: ComposerAttributedDocument.textAttributes))
    }
    view.replaceCharacters(
      in: range, with: insertion, selection: NSRange(location: range.location + 2, length: 0))
    clearMention()
    input.focusRequested()
    view.scrollRangeToVisible(view.selectedRange)
  }

  private var mounted: [Input] {
    inputs.values.filter {
      $0.isCurrent() && $0.view?.window != nil && $0.view?.isEditable == true
    }.sorted { $0.order < $1.order }
  }

  var view: ComposerTextView? { mounted.last(where: \.canAppend)?.view }

  func register(
    _ view: ComposerTextView, blockID: UUID?, order: Int, canAppend: Bool,
    isCurrent: @escaping @MainActor () -> Bool,
    searchableRanges: @escaping @MainActor () -> [NSRange]?,
    focusRequested: @escaping @MainActor () -> Void
  ) {
    inputs[ObjectIdentifier(view)] = Input(
      view: view, blockID: blockID, order: order, canAppend: canAppend, isCurrent: isCurrent,
      searchableRanges: searchableRanges, focusRequested: focusRequested)
  }

  func unregister(_ view: ComposerTextView) {
    if mentionView === view { clearMention() }
    inputs.removeValue(forKey: ObjectIdentifier(view))
  }

  func dismissKeyboard() {
    dismissMentions()
    workflows.dismiss()
    for input in inputs.values where input.isCurrent() {
      input.view?.setFocused(false)
    }
  }

  func prepareForFeedbackRemoval(_ id: UUID) -> UUID? {
    let input = mounted.first { $0.view?.isFirstResponder == true }
    input?.view?.unmarkText()
    dismissMentions()
    workflows.dismiss()
    // A retained note editor must not undo back into the discarded note.
    if input?.blockID == id { input?.view?.undoManager?.removeAllActions() }
    return input?.blockID
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
