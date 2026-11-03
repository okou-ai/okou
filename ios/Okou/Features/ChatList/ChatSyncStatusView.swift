import SwiftUI

/// One visible navigation surface presents synchronization failures; routine updates stay silent.
struct ChatSyncStatusView: View {
  let state: ChatSynchronizationState?
  let retry: @MainActor () async -> Void
  @State private var displayed: ChatSynchronizationState?
  @State private var dismissed: ChatSynchronizationState?
  @State private var isRetrying = false

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if let displayed, displayed != dismissed {
        ChatFeedbackSurface(
          message: displayed.label,
          systemImage: displayed == .unavailable
            ? "exclamationmark.circle" : "arrow.triangle.2.circlepath",
          isWorking: isRetrying || displayed != .unavailable,
          actionTitle: displayed == .unavailable ? String(localized: "Retry") : nil,
          actionEnabled: state == .unavailable,
          actionIdentifier: "chat-sync-retry",
          action: {
            guard !isRetrying else { return }
            Task {
              isRetrying = true
              await retry()
              isRetrying = false
            }
          }, dismiss: { dismissed = displayed })
      }
    }
    .task(id: state) {
      if state != dismissed { dismissed = nil }
      guard let state, state == .unavailable else {
        displayed = nil
        return
      }
      do { try await Task.sleep(for: .milliseconds(300)) } catch { return }
      guard !Task.isCancelled else { return }
      displayed = state
    }
  }
}
