import ChatDomain
import SwiftUI

struct ConversationWorkHeader: View {
  let section: ChatWorkSection
  let expanded: Bool
  let toggle: () -> Void

  var body: some View {
    Group {
      if let endTime = section.endTime {
        control(at: endTime)
      } else {
        TimelineView(.periodic(from: .now, by: 1)) { context in
          control(at: context.date)
        }
      }
    }
    .font(.subheadline)
    .foregroundStyle(.secondary)
  }

  @ViewBuilder
  private func control(at date: Date) -> some View {
    if section.isCollapsible {
      Button(action: toggle) { label(at: date) }
        .buttonStyle(.plain)
        .accessibilityLabel(expanded ? "Collapse work history" : "Expand work history")
        .accessibilityValue(
          "\(timeLabel(at: date)), \(section.stepCount) \(section.stepCount == 1 ? "step" : "steps"), \(expanded ? "Expanded" : "Collapsed")"
        )
        .accessibilityIdentifier(section.id)
    } else {
      label(at: date)
    }
  }

  private func label(at date: Date) -> some View {
    HStack(spacing: 8) {
      Image(systemName: "hourglass").frame(width: 16).accessibilityHidden(true)
      Text(timeLabel(at: date))
      if section.stepCount > 0 {
        Text("·")
        Text("\(section.stepCount) \(section.stepCount == 1 ? "step" : "steps")")
      }
      if section.isCollapsible {
        Image(systemName: "chevron.right")
          .font(.caption)
          .rotationEffect(.degrees(expanded ? 90 : 0))
          .accessibilityHidden(true)
      }
    }
    .lineLimit(1)
    .padding(.vertical, 10)
    .frame(minHeight: 44)
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
  }

  private func timeLabel(at date: Date) -> String {
    "\(section.endTime == nil ? "Working" : "Worked") for \(duration(until: date))"
  }

  private func duration(until date: Date) -> String {
    let seconds = max(1, Int(date.timeIntervalSince(section.startTime).rounded()))
    if seconds < 60 { return "\(seconds) sec" }
    let minutes = Int((Double(seconds) / 60).rounded())
    if minutes >= 60 {
      let remainder = minutes % 60
      return "\(minutes / 60) hr" + (remainder > 0 ? " \(remainder) min" : "")
    }
    return "\(minutes) min"
  }
}

/// Width comes from the measured native cell, including rotation and Dynamic Type layouts.
struct UserMessageBubbleLayout: Layout {
  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    guard let bubble = subviews.first else { return .zero }
    let width = proposal.replacingUnspecifiedDimensions().width
    let size = bubble.sizeThatFits(ProposedViewSize(width: width * 0.85, height: nil))
    return CGSize(width: width, height: size.height)
  }

  func placeSubviews(
    in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()
  ) {
    subviews.first?.place(
      at: CGPoint(x: bounds.maxX, y: bounds.minY), anchor: .topTrailing,
      proposal: ProposedViewSize(width: bounds.width * 0.85, height: nil))
  }
}
