import SwiftUI

/// Shared native surface for transient feedback and recoverable synchronization.
struct ChatFeedbackSurface: View {
  let message: String
  let systemImage: String
  var isWorking = false
  var actionTitle: String?
  var actionEnabled = true
  var actionIdentifier = "chat-feedback-action"
  let action: () -> Void
  let dismiss: () -> Void
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @ScaledMetric(relativeTo: .subheadline) private var fontSize: CGFloat = 14

  var body: some View {
    Group {
      if dynamicTypeSize.isAccessibilitySize {
        VStack(alignment: .leading, spacing: 0) {
          HStack(alignment: .top, spacing: 8) {
            messageLabel.padding(.top, 10)
            dismissButton
          }
          if let actionTitle { actionButton(title: actionTitle).padding(.leading, 24) }
        }
      } else {
        HStack(spacing: 8) {
          messageLabel
          if let actionTitle { actionButton(title: actionTitle) }
          dismissButton
        }
      }
    }
    .font(.system(size: fontSize))
    .padding(.leading, 12)
    .padding(.trailing, 2)
    .padding(.vertical, 2)
    .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
    .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 20))
    .accessibilityElement(children: .contain)
  }

  private var messageLabel: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Group {
        if isWorking {
          ProgressView().controlSize(.mini)
        } else {
          Image(systemName: systemImage)
            .font(.system(size: 14))
            .foregroundStyle(.secondary)
        }
      }
      .frame(width: 16)
      .accessibilityHidden(true)
      Text(message)
        .foregroundStyle(.primary)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private func actionButton(title: String) -> some View {
    Button(title, action: action)
      .font(.system(size: fontSize, weight: .semibold))
      .foregroundStyle(.primary)
      .padding(.horizontal, 6)
      .frame(minWidth: 44, minHeight: 44)
      .contentShape(Rectangle())
      .buttonStyle(.plain)
      .disabled(!actionEnabled || isWorking)
      .accessibilityIdentifier(actionIdentifier)
  }

  private var dismissButton: some View {
    Button(action: dismiss) {
      Image(systemName: "xmark")
        .font(.caption)
        .foregroundStyle(.secondary)
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Dismiss feedback")
    .accessibilityIdentifier("dismiss-chat-feedback")
  }
}

struct ChatFeedbackOverlay: View {
  let store: WorkspaceStore

  var body: some View {
    Group {
      if let feedback = store.threadFeedback {
        ChatThreadFeedbackView(store: store, feedback: feedback)
          .id(feedback.id)
      } else {
        ChatSyncStatusView(state: store.synchronizationState) {
          await store.retrySynchronization()
        }
      }
    }
    .padding(.horizontal, 16)
  }
}
