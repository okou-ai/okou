import SwiftUI
import WidgetKit

@main
struct OkouWidgetsBundle: WidgetBundle {
  init() {
    OkouWidgetFonts.register()
  }

  var body: some Widget {
    OkouStatusWidget()
    OkouNewChatControl()
    OkouVoiceControl()
  }
}
