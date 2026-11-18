import SwiftUI

/// The one floating surface for chat feedback — a finished action ("Chat archived · Undo") or a
/// sync failure with Retry — above the bottom bar: Liquid Glass, a 16 pt Lucide glyph (a
/// small spinner while it works), one 15 pt line, an optional text action and a ✕. Routine
/// updates never show here. At accessibility sizes the action moves under the text.
/// Swipe horizontally to dismiss without competing with bottom-edge system gestures.
struct ChatFeedbackSurface: View {
  let message: String
  let icon: String
  var isWorking = false
  var actionTitle: String?
  var actionEnabled = true
  var actionIdentifier = "chat-feedback-action"
  var actionHint = ""
  var autoDismissAfter: Duration?
  let action: () -> Void
  let dismiss: () -> Void
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
  @Environment(\.scenePhase) private var scenePhase
  @GestureState private var dismissOffset: CGFloat = 0
  @GestureState private var isDragging = false
  @State private var isActionPressed = false
  @State private var isDismissPressed = false

  private var isInteracting: Bool { isDragging || isActionPressed || isDismissPressed }

  private var canAutoDismiss: Bool {
    autoDismissAfter != nil && !isInteracting && !voiceOver && scenePhase == .active
  }

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
    .contentShape(RoundedRectangle(cornerRadius: OkouRadius.card, style: .continuous))
    .offset(x: reduceMotion ? 0 : dismissOffset)
    .animation(reduceMotion ? nil : OkouMotion.press, value: isDragging)
    .simultaneousGesture(
      DragGesture(minimumDistance: OkouSpace.md)
        .updating($isDragging) { _, dragging, _ in dragging = true }
        .updating($dismissOffset) { value, offset, _ in
          if abs(value.translation.width) > max(OkouSpace.md, abs(value.translation.height)) {
            offset = value.translation.width
          }
        }
        .onEnded { value in
          guard abs(value.translation.width) > max(OkouSpace.md, abs(value.translation.height)),
            abs(value.translation.width) > OkouControl.minimumTarget
              || (value.predictedEndTranslation.width * value.translation.width > 0
                && abs(value.predictedEndTranslation.width) > OkouControl.minimumTarget * 2)
          else { return }
          dismiss()
        }
    )
    // Only the visible feedback owns expiry; overlay handoff starts a fresh idle window.
    .task(id: canAutoDismiss) {
      guard canAutoDismiss, let autoDismissAfter else { return }
      do {
        try await Task.sleep(for: autoDismissAfter)
        try Task.checkCancellation()
        dismiss()
      } catch {}
    }
    .padding(.vertical, OkouSpace.sm)
    .accessibilityElement(children: .contain)
    .accessibilityAction(.escape, dismiss)
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
      .fixedSize(horizontal: true, vertical: false)
      .foregroundStyle(OkouColor.foreground)
      .padding(.horizontal, OkouSpace.six)
      .frame(minWidth: OkouControl.minimumTarget, minHeight: OkouControl.minimumTarget)
      .contentShape(Rectangle())
      .buttonStyle(ChatFeedbackButtonStyle(isPressed: $isActionPressed))
      .disabled(!actionEnabled || isWorking)
      .accessibilityIdentifier(actionIdentifier)
      .accessibilityHint(Text(actionHint))
  }

  private var dismissButton: some View {
    Button(action: dismiss) {
      OkouIcon("x", size: OkouIconSize.inline)
        .foregroundStyle(OkouColor.mutedForeground)
        .frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
        .contentShape(Rectangle())
    }
    .buttonStyle(ChatFeedbackButtonStyle(isPressed: $isDismissPressed))
    .accessibilityLabel("Dismiss feedback")
    .accessibilityIdentifier("dismiss-chat-feedback")
  }
}

private struct ChatFeedbackButtonStyle: ButtonStyle {
  @Binding var isPressed: Bool

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .opacity(configuration.isPressed ? 0.5 : 1)
      .onChange(of: configuration.isPressed) { _, pressed in isPressed = pressed }
      .onDisappear { isPressed = false }
  }
}
