import CCStateSwiftUI
import ChatDomain
import SwiftUI
import UIKit

/// Shared transcript footer for both live conversations and new-chat submission handoff.
struct ConversationFooterView: View {
  static let topPadding = OkouSpace.xxl
  static let bottomPadding = OkouSpace.xl
  static let contentSpacing = OkouSpace.xxl
  static let anchorHeight = OkouSpace.one
  static let activityLineHeight: CGFloat = 24

  let state: ChatExecutionState
  let showsAvatar: Bool
  let avatarMotion: OkouAvatar.Motion
  var summary: ConversationActivitySummary?
  var sendTransition: ConversationSendTransition?
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  static func showsActivity(for state: ChatExecutionState) -> Bool {
    state == .queued || state == .running
  }

  @MainActor
  static func hidesActivity(during sendTransition: ConversationSendTransition?) -> Bool {
    sendTransition?.hidesBubbleID != nil
  }

  static func measuredHeight(
    for state: ChatExecutionState, showsAvatar: Bool, traits: UITraitCollection
  ) -> CGFloat {
    var height = topPadding + anchorHeight + bottomPadding
    if showsActivity(for: state) {
      let lineHeight = UIFontMetrics(forTextStyle: .subheadline).scaledValue(
        for: activityLineHeight, compatibleWith: traits)
      let activityHeight = showsAvatar ? max(OkouAvatarSize.message, lineHeight) : lineHeight
      height += activityHeight + contentSpacing
    }
    return height
  }

  var body: some View {
    let hidesActivity = Self.hidesActivity(during: sendTransition)
    VStack(alignment: .leading, spacing: Self.contentSpacing) {
      if Self.showsActivity(for: state) {
        HStack(spacing: OkouSpace.sm) {
          if showsAvatar {
            OkouAvatar(size: OkouAvatarSize.message, motion: avatarMotion, label: "Okou")
              .accessibilityIdentifier("assistant-avatar")
          }
          if let summary {
            ConversationActivityLabel(summary: summary, state: state)
          } else {
            ConversationActivityStatusRow(text: state.label)
          }
        }
        .padding(.leading, showsAvatar ? 0 : OkouSpace.six)
        .opacity(hidesActivity ? 0 : 1)
        .animation(
          hidesActivity || reduceMotion ? nil : .easeOut(duration: 0.16), value: hidesActivity)
      }
      Color.clear.frame(height: Self.anchorHeight)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(
      EdgeInsets(
        top: Self.topPadding, leading: ConversationCollectionRow.messageHorizontalInset,
        bottom: Self.bottomPadding, trailing: ConversationCollectionRow.messageHorizontalInset))
  }
}

/// Observed inside the existing footer host: rotating text never revises measured transcript rows.
/// Transcript cells host SwiftUI outside the workspace root, so the label provides the session
/// Store that keeps the summary's demand.
struct ConversationActivityLabel: View {
  let summary: ConversationActivitySummary
  let state: ChatExecutionState

  var body: some View {
    StoreProvider(summary.store) {
      ConversationActivityContent(summary: summary, state: state)
        .id(ObjectIdentifier(summary))
    }
  }
}

private struct ConversationActivityContent: View {
  let summary: ConversationActivitySummary
  let state: ChatExecutionState
  @LoadableValue private var summaryValue: Loadable<ConversationActivitySummaryValue?>
  @LoadableValue private var selection: Loadable<ConversationActivitySummary.Selection>
  @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver

  init(summary: ConversationActivitySummary, state: ChatExecutionState) {
    self.summary = summary
    self.state = state
    _summaryValue = LoadableValue(task: summary.value, keepLast: true)
    _selection = LoadableValue(summary.selection)
  }

  private var executionText: String {
    guard state == .running, case .hasData(let batch) = summaryValue,
      let current = selection.data
    else { return state.label }
    return ConversationActivitySummary.text(in: batch, selection: current) ?? state.label
  }

  var body: some View {
    ConversationActivityStatusRow(text: executionText)
      // No live-region announcements or motion; VoiceOver can finish reading a phrase.
      .onAppear { summary.setRotates(!voiceOver) }
      .onChange(of: voiceOver) { _, enabled in summary.setRotates(!enabled) }
  }
}

private struct ConversationActivityStatusRow: View {
  let text: String
  @ScaledMetric(relativeTo: .subheadline) private var lineHeight =
    ConversationFooterView.activityLineHeight

  var body: some View {
    HStack(spacing: OkouSpace.sm) {
      OkouThinkingMark()
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
  }
}
