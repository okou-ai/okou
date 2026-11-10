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
      ConversationActivityValue(summary: summary, state: state)
    }
  }
}

private struct ConversationActivityValue: View {
  let summary: ConversationActivitySummary
  let state: ChatExecutionState
  @LoadableValue private var demandedRun: Loadable<String?>
  @LoadableValue private var value: Loadable<ChatActivitySummary?>

  init(summary: ConversationActivitySummary, state: ChatExecutionState) {
    self.summary = summary
    self.state = state
    _demandedRun = LoadableValue(summary.demandedRun)
    _value = LoadableValue(task: summary.value, keepLast: true)
  }

  @ScaledMetric(relativeTo: .subheadline) private var lineHeight = 24
  @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver

  private var messages: [ChatActivitySummary.Message] {
    guard case .hasData(let run) = demandedRun, case .hasData(let result) = value,
      let result, result.runId == run, result.status == .available
    else { return [] }
    return result.messages
  }

  var body: some View {
    let text = state == .running ? summary.phrases.text(in: messages) ?? state.label : state.label
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
    .onAppear { summary.phrases.setRotates(!voiceOver) }
    .onChange(of: voiceOver) { _, enabled in summary.phrases.setRotates(!enabled) }
  }
}
