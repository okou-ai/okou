import SwiftUI

/// The one floating surface for chat feedback — a finished action ("Chat archived · Undo") or a
/// sync failure with Retry — just under the header: Liquid Glass, a 16 pt Lucide glyph (a
/// small spinner while it works), one 15 pt line, an optional text action and a ✕. Routine
/// updates never show here. At accessibility sizes the action moves under the text.
struct ChatFeedbackSurface: View {
  let message: String
  let icon: String
  var isWorking = false
  var actionTitle: String?
  var actionEnabled = true
  var actionIdentifier = "chat-feedback-action"
  let action: () -> Void
  let dismiss: () -> Void
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  var body: some View {
    Group {
      if dynamicTypeSize.isAccessibilitySize {
        VStack(alignment: .leading, spacing: 0) {
          HStack(alignment: .top, spacing: OkouSpace.sm) {
            messageLabel.padding(.top, OkouSpace.ten)
            dismissButton
          }
          if let actionTitle {
            actionButton(title: actionTitle).padding(.leading, OkouSpace.xxl)
          }
        }
      } else {
        HStack(spacing: OkouSpace.sm) {
          messageLabel
          if let actionTitle { actionButton(title: actionTitle) }
          dismissButton
        }
      }
    }
    .font(.okou(.subheadline))
    .padding(.leading, OkouSpace.md)
    .padding(.trailing, OkouSpace.two)
    .padding(.vertical, OkouSpace.two)
    .frame(maxWidth: .infinity, minHeight: OkouControl.listRow, alignment: .leading)
    .glassEffect(.regular, in: RoundedRectangle(cornerRadius: OkouRadius.card, style: .continuous))
    .padding(.vertical, OkouSpace.sm)
    .accessibilityElement(children: .contain)
  }

  private var messageLabel: some View {
    HStack(alignment: .firstTextBaseline, spacing: OkouSpace.sm) {
      // Centred on the message's first line (see `OkouLineIcon`).
      OkouLineIcon(font: .okou(.subheadline).weight(.medium), width: OkouIconSize.inline) {
        if isWorking {
          ProgressView().controlSize(.mini).tint(OkouColor.mutedForeground)
        } else {
          OkouIcon(icon, size: OkouIconSize.inline)
            .foregroundStyle(OkouColor.mutedForeground)
        }
      }
      Text(message)
        .font(.okou(.subheadline).weight(.medium))
        .foregroundStyle(OkouColor.foreground)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private func actionButton(title: String) -> some View {
    // Semibold ink, as `OkouBanner`'s actions: the weight, not a brand colour, marks the action.
    Button(title, action: action)
      .font(.okou(.subheadline).weight(.semibold))
      .foregroundStyle(OkouColor.foreground)
      .padding(.horizontal, OkouSpace.six)
      .frame(minWidth: OkouControl.minimumTarget, minHeight: OkouControl.minimumTarget)
      .contentShape(Rectangle())
      .buttonStyle(.plain)
      .disabled(!actionEnabled || isWorking)
      .accessibilityIdentifier(actionIdentifier)
  }

  private var dismissButton: some View {
    Button(action: dismiss) {
      OkouIcon("x", size: OkouIconSize.inline)
        .foregroundStyle(OkouColor.mutedForeground)
        .frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Dismiss feedback")
    .accessibilityIdentifier("dismiss-chat-feedback")
  }
}
