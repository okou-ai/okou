import SwiftUI

/// One visible navigation surface presents the workspace's shared synchronization state.
struct ChatSyncStatusView: View {
  let state: ChatSynchronizationState?
  let retry: @MainActor () async -> Void
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @State private var displayed: ChatSynchronizationState?

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if let displayed {
        Group {
          if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 8) {
              statusLabel(displayed)
              retryButton(displayed)
            }
          } else {
            HStack(spacing: 12) {
              statusLabel(displayed)
                .frame(maxWidth: .infinity, alignment: .leading)
              retryButton(displayed)
            }
          }
        }
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .padding(12)
        .background(
          Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16)
        )
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
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

  private func statusLabel(_ state: ChatSynchronizationState) -> some View {
    Label(
      state.label,
      systemImage: state == .unavailable ? "exclamationmark.circle" : "arrow.triangle.2.circlepath"
    )
    .font(.footnote)
    .foregroundStyle(.secondary)
    .fixedSize(horizontal: false, vertical: true)
  }

  @ViewBuilder private func retryButton(_ displayed: ChatSynchronizationState) -> some View {
    if displayed == .unavailable {
      Button("Try again") { Task { await retry() } }
        .buttonStyle(ChatCardButtonStyle())
        .fixedSize(horizontal: true, vertical: false)
        .disabled(state != .unavailable)
    }
  }
}
