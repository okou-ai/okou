import CCStateSwiftUI
import ChatData
import ChatDomain
import SwiftUI

/// Observed inside the existing footer host: rotating text never revises measured transcript rows.
struct ConversationActivityLabel: View {
  let summary: ConversationActivitySummary
  let state: ChatExecutionState

  var body: some View {
    StoreProvider(summary.stateStore) {
      ConversationActivityContent(summary: summary, state: state)
        .id(ObjectIdentifier(summary))
    }
  }
}

private struct ConversationActivityContent: View {
  let summary: ConversationActivitySummary
  let state: ChatExecutionState
  @LoadableValue private var messages: Loadable<ChatActivitySummary?>

  init(summary: ConversationActivitySummary, state: ChatExecutionState) {
    self.summary = summary
    self.state = state
    _messages = LoadableValue(task: summary.value, keepLast: true)
  }

  @ScaledMetric(relativeTo: .subheadline) private var lineHeight = 24
  @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver

  var body: some View {
    let text: String
    if state == .running, case .hasData(let batch) = messages {
      text = summary.text(in: batch) ?? state.label
    } else {
      text = state.label
    }
    HStack(spacing: OkouSpace.sm) {
      OkouRunningIndicator().frame(width: 16)
      Text(verbatim: text)
        .font(.okou(.subheadline))
        .foregroundStyle(OkouColor.mutedForeground)
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
