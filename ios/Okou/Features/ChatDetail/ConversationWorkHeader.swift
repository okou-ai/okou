import ChatDomain
import SwiftUI

struct ConversationWorkHeader: View {
  let section: ChatWorkSection
  let expanded: Bool
  /// The run ended in a failure; the header must not read like a finished run.
  var failed = false
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
    .font(.okou(.subheadline))
    .foregroundStyle(OkouColor.mutedForeground)
  }

  @ViewBuilder
  private func control(at date: Date) -> some View {
    if section.isCollapsible {
      Button(action: toggle) { label(at: date) }
        .buttonStyle(.plain)
        .accessibilityLabel(expanded ? "Collapse work history" : "Expand work history")
        .accessibilityValue(
          Text(
            "\(timeLabel(at: date)), \(section.stepCount) steps, \(expanded ? String(localized: "Expanded") : String(localized: "Collapsed"))"
          )
        )
        .accessibilityIdentifier(section.id)
    } else {
      label(at: date)
    }
  }

  private func label(at date: Date) -> some View {
    HStack(spacing: OkouSpace.sm) {
      OkouIcon(failed ? "circle-alert" : "hourglass", size: OkouIconSize.inline)
        .foregroundStyle(OkouColor.mutedForeground)
        .accessibilityHidden(true)
      Text(timeLabel(at: date))
      if section.stepCount > 0 {
        Text(verbatim: "·")
        Text("\(section.stepCount) steps")
      }
      if section.isCollapsible {
        OkouIcon("chevron-right", size: OkouIconSize.inline)
          .rotationEffect(.degrees(expanded ? 90 : 0))
          .accessibilityHidden(true)
      }
    }
    .lineLimit(1)
    .padding(.vertical, OkouSpace.ten)
    .frame(minHeight: OkouControl.minimumTarget)
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
  }

  private func timeLabel(at date: Date) -> String {
    let duration = duration(until: date)
    if section.endTime == nil { return String(localized: "Working for \(duration)") }
    if failed { return String(localized: "Stopped after \(duration)") }
    return String(localized: "Worked for \(duration)")
  }

  private func duration(until date: Date) -> String {
    let seconds = max(1, date.timeIntervalSince(section.startTime).rounded())
    let formatter = DateComponentsFormatter()
    formatter.unitsStyle = .short
    formatter.allowedUnits =
      seconds < 60 ? [.second] : (seconds < 3600 ? [.minute] : [.hour, .minute])
    formatter.maximumUnitCount = 2
    return formatter.string(from: seconds < 60 ? seconds : (seconds / 60).rounded() * 60)
      ?? "\(Int(seconds)) sec"
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
