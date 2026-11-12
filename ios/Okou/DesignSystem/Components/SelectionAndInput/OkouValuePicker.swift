import SwiftUI

extension View {
  /// A picker that shows its current value at the trailing edge of a row (Thinking effort,
  /// Appearance, Allow for …). The label stays `foreground`; the value and chevron are
  /// `trailingValue`, a step lighter, as in the system Settings app. The app's global
  /// `foreground` tint otherwise drew the value as heavy as its label.
  func okouValuePicker() -> some View {
    pickerStyle(.menu).tint(OkouColor.trailingValue)
  }
}
