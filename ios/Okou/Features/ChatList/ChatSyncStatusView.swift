import SwiftUI

/// One visible navigation surface presents the workspace's shared synchronization state.
struct ChatSyncStatusView: View {
  let state: ChatSynchronizationState?
  let retry: @MainActor () async -> Void
  @State private var displayed: ChatSynchronizationState?

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if let displayed {
        // A slow or failed sync is status, not an alarm: the shared quiet banner.
        OkouBanner(
          Text(displayed.label),
          icon: displayed == .unavailable ? "circle-alert" : "refresh-cw",
          tone: displayed == .unavailable ? .problem : .status
        ) {
          if displayed == .unavailable {
            Button("Try again") { Task { await retry() } }
              .disabled(state != .unavailable)
          }
        }
        .padding(.horizontal, OkouSpace.lg)
        .padding(.top, OkouSpace.md)
        .padding(.bottom, OkouSpace.sm)
      }
    }
    .task(id: state) {
      guard let state else {
        displayed = nil
        return
      }
      // Routine catch-up usually finishes within a second, and screens show their own
      // loading state meanwhile; only a slow sync or a failure earns the banner.
      let delay = state == .unavailable ? Duration.milliseconds(300) : OkouMotion.syncBannerDelay
      do { try await Task.sleep(for: delay) } catch { return }
      guard !Task.isCancelled else { return }
      displayed = state
    }
  }
}
