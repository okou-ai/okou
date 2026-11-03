import SwiftUI

/// One visible navigation surface presents the workspace's shared synchronization state.
struct ChatSyncStatusView: View {
  let state: ChatSynchronizationState?
  let retry: @MainActor () async -> Void
  @State private var displayed: ChatSynchronizationState?

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if let displayed {
        HStack(spacing: 12) {
          Text(displayed.label)
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
          Spacer(minLength: 0)
          if displayed == .unavailable {
            Button("Try again") { Task { await retry() } }
              .font(.caption.weight(.semibold))
              .frame(minHeight: 44)
              .disabled(state != .unavailable)
          }
        }
        .padding(.horizontal, 16)
        .background(.regularMaterial)
        .accessibilityElement(children: .contain)
      }
    }
    .task(id: state) {
      guard let state else {
        displayed = nil
        return
      }
      do { try await Task.sleep(for: .milliseconds(300)) } catch { return }
      guard !Task.isCancelled else { return }
      displayed = state
    }
  }
}
