import SwiftUI

/// Dismisses a viewing surface; the native toolbar supplies its glass and target.
struct OkouCloseButton: View {
  let action: () -> Void

  var body: some View {
    Button("Close", okouSymbol: "x", action: action)
      .labelStyle(.iconOnly)
  }
}
