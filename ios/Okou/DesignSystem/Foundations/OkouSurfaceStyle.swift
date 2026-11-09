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

extension View {
  /// Every grouped list or form in a sheet: the same neutral grouped ground with the system's
  /// rows (the warm grey ramp read as pink behind white rows), and the soft blur under the
  /// sheet's title bar and none at the bottom. Sheets are hosted separately and do not inherit
  /// the app root's scroll-edge style, so they get it here and cannot forget it. A page drawn
  /// as the web draws it (the connector directory, whose track and chips are web greys made
  /// for white) passes the white page ground instead.
  ///
  /// The sheet's own ground is not set here but at the sheet's root (`okouSheetBackground()`):
  /// set from inside the sheet's navigation stack, it reaches the sheet after its slide has
  /// begun, and the sheet then jumps into place while only its rows slide up.
  func okouGroupedBackground(_ ground: Color = OkouGroupedColor.background) -> some View {
    scrollContentBackground(.hidden)
      .background(ground)
      .scrollEdgeEffectStyle(.soft, for: .top)
      .scrollEdgeEffectHidden(true, for: .bottom)
      // The first card starts just under the title bar instead of a header's worth below.
      .contentMargins(.top, OkouSpace.sm, for: .scrollContent)
      // One row height for every grouped sheet, so single-row cards match and rows do not
      // set heights of their own.
      .environment(\.defaultMinListRowHeight, OkouControl.groupedRow)
  }

  /// A sheet's opaque ground, applied to the view the sheet presents, beside its detents. At a
  /// partial detent an iOS 26 sheet is otherwise glass and the system turns grouped rows grey;
  /// full height it is opaque and rows are white, so one opaque ground keeps one look. Only at
  /// the root does the ground slide up with the sheet.
  func okouSheetBackground(_ ground: Color = OkouGroupedColor.background) -> some View {
    presentationBackground(ground)
  }
}
