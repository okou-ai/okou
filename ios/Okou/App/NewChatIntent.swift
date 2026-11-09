import AppIntents

/// A parameterless action for the default App Shortcut and personal shortcuts.
struct NewChatIntent: AppIntent {
  static let title: LocalizedStringResource = "New chat"
  static let description = IntentDescription(
    "Opens a new chat with the keyboard ready for typing.")
  static let openAppWhenRun = true

  @MainActor
  func perform() async throws -> some IntentResult {
    NewChatRequests.shared.request()
    return .result()
  }
}

struct VoiceInputIntent: AppIntent {
  static let title: LocalizedStringResource = "Voice Input"
  static let description = IntentDescription(
    "Opens a new chat and starts voice input without sending a message.")
  static let openAppWhenRun = true

  @MainActor
  func perform() async throws -> some IntentResult {
    NewChatRequests.shared.request(startVoiceInput: true)
    return .result()
  }
}

struct OkouShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: NewChatIntent(),
      phrases: ["New \(.applicationName) chat"],
      shortTitle: "New chat",
      // App Shortcuts accept only SF Symbols; this is the system's own surface.
      systemImageName: "square.and.pencil")
    AppShortcut(
      intent: VoiceInputIntent(),
      phrases: ["Start voice input in \(.applicationName)"],
      shortTitle: "Voice Input",
      systemImageName: "mic")
  }
}
