import SwiftUI

/// The trailing control on a catalog card, as the web draws it: "+" in an outlined square adds
/// straight from the list without opening the item; once added it turns into a chevron with
/// no edge, and the whole card opens the item to manage it. Drawn at 32 pt inside a 44 pt
/// target.
struct OkouAddIndicator: View {
  let isAdded: Bool

  var body: some View {
    let shape = RoundedRectangle(cornerRadius: OkouRadius.small, style: .continuous)
    OkouIcon(isAdded ? "chevron-right" : "plus", size: OkouIconSize.inline)
      .foregroundStyle(OkouColor.mutedForeground)
      .frame(width: OkouControl.addControl, height: OkouControl.addControl)
      .overlay {
        shape.strokeBorder(
          isAdded ? Color.clear : OkouColor.controlBorder, lineWidth: OkouSpace.hairline)
      }
      .frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
      .contentShape(Rectangle())
  }
}
