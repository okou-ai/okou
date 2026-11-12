import SwiftUI

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
