import SwiftUI

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
