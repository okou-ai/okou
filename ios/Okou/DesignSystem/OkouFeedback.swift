import SwiftUI

/// A status line that sits in a screen's flow (sync delayed, a draft that could not be saved,
/// a stop that did not confirm): a hairline card, a 16 pt glyph, one footnote sentence and at
/// most a couple of quiet text actions. As in ChatGPT and Manus, a problem is quiet: it never
/// turns red; `.problem` only lifts the text from supporting grey to the text colour.
struct OkouBanner<Actions: View>: View {
  enum Tone { case status, problem }

  let message: Text
  let icon: String
  var tone: Tone = .status
  var dismiss: (() -> Void)? = nil
  let actions: Actions
  /// One footnote line, so the glyph and the ✕ centre on the first line of the message.
  @ScaledMetric(relativeTo: .footnote) private var lineHeight: CGFloat = 18

  init(
    _ message: Text, icon: String, tone: Tone = .status, dismiss: (() -> Void)? = nil,
    @ViewBuilder actions: () -> Actions
  ) {
    self.message = message
    self.icon = icon
    self.tone = tone
    self.dismiss = dismiss
    self.actions = actions()
  }

  var body: some View {
    HStack(alignment: .top, spacing: OkouSpace.sm) {
      OkouIcon(icon, size: OkouIconSize.inline)
        .foregroundStyle(textColor)
        .frame(height: lineHeight)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: OkouSpace.six) {
        message
          .font(.okou(.footnote))
          .foregroundStyle(textColor)
          .fixedSize(horizontal: false, vertical: true)
        if Actions.self != EmptyView.self {
          HStack(spacing: OkouSpace.lg) { actions }
            .font(.okou(.footnote).weight(.semibold))
            .foregroundStyle(OkouColor.foreground)
            .buttonStyle(.plain)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      if let dismiss {
        Button(action: dismiss) {
          OkouIcon("x", size: OkouIconSize.inline)
            .foregroundStyle(OkouColor.mutedForeground)
            .frame(width: OkouControl.minimumTarget, height: lineHeight)
            .contentShape(Rectangle().inset(by: -OkouSpace.ten))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Dismiss")
      }
    }
    .padding(.leading, OkouSpace.md)
    .padding(.trailing, dismiss == nil ? OkouSpace.md : 0)
    .padding(.vertical, OkouSpace.ten)
    .modifier(OkouSurfaceStyle(radius: OkouRadius.chat))
    .accessibilityElement(children: .contain)
  }

  private var textColor: Color {
    switch tone {
    case .status: OkouColor.mutedForeground
    case .problem: OkouColor.foreground
    }
  }
}

extension OkouBanner where Actions == EmptyView {
  init(_ message: Text, icon: String, tone: Tone = .status, dismiss: (() -> Void)? = nil) {
    self.init(message, icon: icon, tone: tone, dismiss: dismiss) { EmptyView() }
  }
}

/// A transient confirmation floating over the content ("Chat archived · Undo"): Liquid Glass
/// the height of a control, one 15 pt medium line, an optional text action and a small ✕.
/// Only floating layers get glass; a toast never carries an icon or colour of its own.
struct OkouToast<Action: View>: View {
  let message: String
  var dismiss: () -> Void
  let action: Action

  init(_ message: String, dismiss: @escaping () -> Void, @ViewBuilder action: () -> Action) {
    self.message = message
    self.dismiss = dismiss
    self.action = action()
  }

  var body: some View {
    HStack(spacing: OkouSpace.sm) {
      Text(message)
        .font(.okou(.subheadline).weight(.medium))
        .foregroundStyle(OkouColor.foreground)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
      action
        .font(.okou(.subheadline).weight(.semibold))
        .foregroundStyle(OkouColor.brandText)
        .buttonStyle(.plain)
        .frame(minHeight: OkouControl.minimumTarget)
      Button(action: dismiss) {
        OkouIcon("x", size: OkouIconSize.inline)
          .foregroundStyle(OkouColor.mutedForeground)
          .frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Dismiss")
    }
    .padding(.leading, OkouSpace.xl)
    .padding(.vertical, OkouSpace.xs)
    .glassEffect(
      .regular,
      in: RoundedRectangle(cornerRadius: OkouControl.minimumTarget / 2 + OkouSpace.xs)
    )
    .accessibilityElement(children: .contain)
  }
}

extension OkouToast where Action == EmptyView {
  init(_ message: String, dismiss: @escaping () -> Void) {
    self.init(message, dismiss: dismiss) { EmptyView() }
  }
}
