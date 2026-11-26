import SwiftUI

/// A date is centered between rules. A finished run labels the rule at its leading edge.
struct ConversationDivider: View {
  let label: String
  var centered = false

  var body: some View {
    HStack(spacing: centered ? OkouSpace.md : OkouSpace.sm) {
      if centered { rule }
      Text(verbatim: label)
        .font(.okou(.subheadline, design: .serif).italic())
        .foregroundStyle(OkouColor.mutedForeground.opacity(0.5))
        .layoutPriority(1)
      rule
    }
    .accessibilityElement(children: .combine)
  }

  private var rule: some View {
    Rectangle()
      .fill(OkouColor.divider.opacity(0.4))
      .frame(height: OkouSpace.one)
      .accessibilityHidden(true)
  }
}
