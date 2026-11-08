import AppIntents

/// A parameterless action for personal shortcuts, including the iPhone Action button.
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
