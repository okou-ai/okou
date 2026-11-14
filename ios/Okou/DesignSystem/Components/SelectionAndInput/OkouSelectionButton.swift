import SwiftUI

/// A message selection mark with a native-sized target and semantic checked colors.
struct OkouSelectionButton: View {
  let isSelected: Bool
  var isIndeterminate = false
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      ZStack {
        Circle().fill(isSelected || isIndeterminate ? OkouColor.primary : OkouColor.background)
        Circle().strokeBorder(
          isSelected || isIndeterminate ? OkouColor.primary : OkouColor.controlBorder)
        if isSelected || isIndeterminate {
          OkouIcon(isIndeterminate ? "minus" : "check", size: OkouIconSize.badge)
            .foregroundStyle(OkouColor.primaryForeground)
        }
      }
      .frame(width: OkouControl.selectionMark, height: OkouControl.selectionMark)
      .frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityValue(
      isIndeterminate ? "Partially selected" : isSelected ? "Selected" : "Not selected")
  }
}
