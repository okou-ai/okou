import SwiftUI

struct OkouSurfaceStyle: ViewModifier {
  var radius: CGFloat = OkouRadius.card

  func body(content: Content) -> some View {
    content
      .background(OkouColor.card, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
      .overlay {
        RoundedRectangle(cornerRadius: radius, style: .continuous)
          .strokeBorder(OkouColor.border, lineWidth: OkouSpace.hairline)
          .allowsHitTesting(false)
      }
  }
}

/// A suggestion panel that floats over the transcript above the composer (slash workflows,
/// @mentions): the same card as the rest of the UI, lifted by a soft shadow so it reads as
/// one object over the text beneath instead of a grey block.
struct OkouFloatingPanelStyle: ViewModifier {
  var radius: CGFloat = OkouRadius.card

  func body(content: Content) -> some View {
    content
      .modifier(OkouSurfaceStyle(radius: radius))
      .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
      .shadow(
        color: .black.opacity(OkouElevation.floatingOpacity), radius: OkouElevation.floatingRadius,
        y: OkouElevation.floatingY)
  }
}

struct OkouTextFieldStyle: TextFieldStyle {
  var isFocused = false
  @Environment(\.isEnabled) private var isEnabled

  func _body(configuration: TextField<Self._Label>) -> some View {
    configuration
      .font(.okou(.body))
      .foregroundStyle(OkouColor.foreground)
      .tint(OkouColor.foreground)
      .padding(.horizontal, OkouSpace.lg)
      .padding(.vertical, OkouSpace.md)
      .frame(minHeight: OkouControl.largeHeight)
      .background(OkouColor.input, in: RoundedRectangle(cornerRadius: OkouRadius.control))
      .overlay {
        RoundedRectangle(cornerRadius: OkouRadius.control)
          .strokeBorder(
            isFocused ? OkouColor.primary : OkouColor.controlBorder, lineWidth: OkouSpace.hairline
          )
          .allowsHitTesting(false)
      }
      .overlay {
        RoundedRectangle(cornerRadius: OkouRadius.control)
          .stroke(OkouColor.primary.opacity(isFocused ? 0.1 : 0), lineWidth: 3)
          .allowsHitTesting(false)
      }
      .opacity(isEnabled ? 1 : 0.5)
  }
}

extension View {
  /// Every grouped list or form in a sheet: the same neutral grouped ground with the system's
  /// rows (the warm grey ramp read as pink behind white rows), and the soft blur under the
  /// sheet's title bar. Sheets are hosted separately and do not inherit the app root's
  /// scroll-edge style, so they get it here and cannot forget it. A page drawn as the web
  /// draws it (the connector directory, whose track and chips are web greys made for white)
  /// passes the white page ground instead.
  func okouGroupedBackground(_ ground: Color = OkouGroupedColor.background) -> some View {
    scrollContentBackground(.hidden)
      .background(ground)
      .scrollEdgeEffectStyle(.soft, for: .top)
      // The first card starts just under the title bar instead of a header's worth below.
      .contentMargins(.top, OkouSpace.sm, for: .scrollContent)
      // At a partial detent an iOS 26 sheet is glass and the system turns grouped rows grey;
      // full height it is opaque and rows are white. An opaque ground keeps one look.
      .presentationBackground(OkouGroupedColor.background)
      // One row height for every grouped sheet, so single-row cards match and rows do not
      // set heights of their own.
      .environment(\.defaultMinListRowHeight, OkouControl.listRow)
  }
}

extension View {
  /// A picker that shows its current value at the trailing edge of a row (Thinking effort,
  /// Appearance, Allow for …). The label stays `foreground`; the value and chevron are
  /// supporting text, as in the system Settings app. The app's global `foreground` tint
  /// otherwise drew the value as heavy as its label.
  func okouValuePicker() -> some View {
    pickerStyle(.menu).tint(OkouColor.mutedForeground)
  }
}

extension View {
  /// Text under a grouped card (section footer): 13 pt supporting text, as in the system
  /// Settings app. Footers otherwise inherit the app's 17 pt `foreground` body style.
  func okouSectionNote() -> some View {
    font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
  }
}

extension View {
  /// The label above a grouped card: 15 pt medium in `foreground`, in sentence case, the
  /// same weight as the provider headings that carry a logo.
  func okouSectionHeader() -> some View {
    font(.okou(.subheadline).weight(.medium))
      .foregroundStyle(OkouColor.foreground)
      .textCase(nil)
  }
}
