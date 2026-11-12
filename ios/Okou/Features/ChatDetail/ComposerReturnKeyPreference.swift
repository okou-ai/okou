import ChatData
import Observation
import SwiftUI
import UIKit

extension ComposerReturnKeyPreference {
  var title: LocalizedStringKey {
    switch self {
    case .newline: "New line"
    case .send: "Send"
    }
  }
}

/// One app-owned value for all mounted composers and Settings; views never own persistence.
@MainActor @Observable
final class ComposerPreferences {
  private let storage: ComposerPreferencesStorage
  private(set) var returnKey = ComposerReturnKeyPreference.newline
  private(set) var error: String?

  init(storage: ComposerPreferencesStorage) {
    self.storage = storage
    do { returnKey = try storage.returnKey() } catch {
      // Keep typing safe without discarding or overwriting an unreadable preference.
      self.error = String(
        localized: "Unable to load your keyboard preference. New line is being used.")
    }
  }

  func setReturnKey(_ preference: ComposerReturnKeyPreference) {
    do {
      try storage.setReturnKey(preference)
      returnKey = preference
      error = nil
    } catch {
      self.error = String(localized: "Unable to save your keyboard preference. Please try again.")
    }
  }
}

extension EnvironmentValues {
  @Entry var composerPreferences: ComposerPreferences? = nil
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
