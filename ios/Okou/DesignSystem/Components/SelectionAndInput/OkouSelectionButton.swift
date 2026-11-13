import SwiftUI

/// A message selection mark with a native-sized target and semantic checked colors.
struct OkouSelectionButton: View {
  let isSelected: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      ZStack {
        Circle().fill(isSelected ? OkouColor.primary : OkouColor.background)
        Circle().strokeBorder(isSelected ? OkouColor.primary : OkouColor.controlBorder)
        if isSelected {
          OkouIcon("check", size: OkouIconSize.badge)
            .foregroundStyle(OkouColor.primaryForeground)
        }
      }
      .frame(width: OkouControl.selectionMark, height: OkouControl.selectionMark)
      .frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityValue(isSelected ? "Selected" : "Not selected")
  }
}
