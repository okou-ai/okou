import SwiftUI

/// Match the web transcript's 100 ms reveal so cache hits do not flash a loader.
struct ConversationLoadingView: View {
  @State private var revealed = false

  var body: some View {
    ProgressView("Loading conversation…")
      .padding(20)
      .background(.regularMaterial, in: Capsule())
      .opacity(revealed ? 1 : 0)
      .accessibilityHidden(!revealed)
      .allowsHitTesting(false)
      .task {
        do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
        revealed = true
      }
  }
}
