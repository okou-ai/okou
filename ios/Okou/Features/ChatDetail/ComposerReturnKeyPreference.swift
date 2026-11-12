import SwiftUI
import UIKit

/// A device-wide typing preference, independent of chat and workspace selection.
enum ComposerReturnKeyPreference: String, CaseIterable, Identifiable {
  case newline, send

  static let storageKey = "okou.composerReturnKey"

  var id: String { rawValue }

  var title: LocalizedStringKey {
    switch self {
    case .newline: "New line"
    case .send: "Send"
    }
  }
}

extension ComposerTextView {
  func configureReturnKey(_ preference: ComposerReturnKeyPreference) {
    guard returnKeyPreference != preference else { return }
    returnKeyPreference = preference
    returnKeyType = preference == .send ? .send : .default
    if isFirstResponder { reloadInputViews() }
  }

  var canInsertNewline: Bool {
    returnKeyPreference == .send && isEditable && isCurrent()
      && markedTextRange == nil && !isSettlingComposition
  }

  /// A menu edit must bypass the keyboard's Send action and keep the native undo history.
  func insertNewline() {
    guard canInsertNewline else { return }
    let selection = selectedRange
    replaceCharacters(
      in: selection, with: NSAttributedString(string: "\n"),
      selection: NSRange(location: selection.location + 1, length: 0))
    scrollRangeToVisible(selectedRange)
  }
}
