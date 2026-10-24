import SwiftUI

struct ChatSyncFailureView: View {
  let message: String
  let isRefreshing: Bool
  let retry: @MainActor () async -> Void

  var body: some View {
    HStack(spacing: 12) {
      Text(message)
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 0)
      Button("Try again") { Task { await retry() } }
        .font(.caption.weight(.semibold))
        .frame(minHeight: 44)
        .disabled(isRefreshing)
    }
    .padding(.horizontal, 16)
    .background(.regularMaterial)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Unable to update chats")
  }
}
