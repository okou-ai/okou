import AppIntents
import Observation

/// A request handed over by Siri, Spotlight or the Shortcuts app, waiting for the
/// workspace screen to open a new chat with it in the composer. Nothing is sent for the user.
@MainActor @Observable
final class PendingAppRequest {
  static let shared = PendingAppRequest()
  var prompt: String?
}

struct AskOkouIntent: AppIntent {
  static let title: LocalizedStringResource = "Ask Okou"
  static let description = IntentDescription(
    "Opens a new Okou chat with your request in the message box, ready to review and send.")
  static let openAppWhenRun = true

  @Parameter(title: "Request")
  var request: String?

  @MainActor
  func perform() async throws -> some IntentResult {
    PendingAppRequest.shared.prompt = request ?? ""
    return .result()
  }
}

struct OkouShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: AskOkouIntent(),
      phrases: ["Ask \(.applicationName)", "New \(.applicationName) chat"],
      shortTitle: "Ask Okou",
      // App Shortcuts accept only SF Symbols; this is the system's own surface.
      systemImageName: "bubble.left.and.text.bubble.right")
  }
}
