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
  @Entry var composerPreferences: ComposerPreferences?
}

extension ComposerTextView {
  func configureReturnKey(_ preference: ComposerReturnKeyPreference) {
    // As in any native field, Send is disabled only while this editor has no text, and
    // UIKit tracks that as the user types. Quotes, attachments and send readiness never
    // change the trait: iOS can keep an empty editor's key disabled after a mid-session
    // change, and refreshing it restarts the input session, which puts the keyboard away
    // and brings it back. The toolbar's Send reflects that other content.
    let automaticallyEnables = preference == .send
    guard
      returnKeyPreference != preference
        || enablesReturnKeyAutomatically != automaticallyEnables
    else { return }
    returnKeyPreference = preference
    returnKeyType = preference == .send ? .send : .default
    // Only an empty editor can retain the disabled key; a populated one already sends.
    let restartsInputSession = enablesReturnKeyAutomatically && !automaticallyEnables && !hasText
    enablesReturnKeyAutomatically = automaticallyEnables
    requestReturnKeyReload(restartInputSession: restartsInputSession)
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
