import AppIntents
import SwiftUI
import WidgetKit

// Controls appear in Control Center, on the Lock Screen and on the Action button. Like App
// Shortcuts, a control's label takes only SF Symbols: this is the system's own surface.

struct OkouNewChatControl: ControlWidget {
  var body: some ControlWidgetConfiguration {
    StaticControlConfiguration(kind: "ai.okou.controls.new-chat") {
      ControlWidgetButton(action: OpenURLIntent(OkouWidgetLink.newChat)) {
        Label("New chat", systemImage: "square.and.pencil")
      }
    }
    .displayName("New chat")
    .description("Opens a new Okou chat with the keyboard ready.")
  }
}

struct OkouVoiceControl: ControlWidget {
  var body: some ControlWidgetConfiguration {
    StaticControlConfiguration(kind: "ai.okou.controls.voice") {
      ControlWidgetButton(action: OpenURLIntent(OkouWidgetLink.voice)) {
        Label("Voice", systemImage: "mic")
      }
    }
    .displayName("Voice")
    .description("Opens a new Okou chat and starts voice input.")
  }
}
