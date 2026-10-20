import ChatDomain
import SwiftUI

/// Observed inside the existing footer host: rotating text never revises measured transcript rows.
struct ConversationActivityLabel: View {
  let summary: ConversationActivitySummary
  let state: ChatExecutionState
  @ScaledMetric(relativeTo: .subheadline) private var lineHeight = 24
  @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver

  var body: some View {
    let text = state == .running ? summary.text ?? state.label : state.label
    HStack(spacing: 10) {
      ProgressView().controlSize(.small).accessibilityHidden(true)
      Text(verbatim: text)
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .lineLimit(1)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .frame(height: lineHeight)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(Text(verbatim: text))
    .accessibilityIdentifier("execution-status")
    // No live-region announcements or motion; VoiceOver can finish reading a phrase.
    .onAppear { summary.setRotates(!voiceOver) }
    .onChange(of: voiceOver) { _, enabled in summary.setRotates(!enabled) }
  }
}
