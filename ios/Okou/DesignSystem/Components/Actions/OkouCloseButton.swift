import SwiftUI

/// Dismisses a viewing surface; the native toolbar supplies its glass and target.
struct OkouCloseButton: View {
  let action: () -> Void

  var body: some View {
    Button("Close", okouSymbol: "x", action: action)
      .labelStyle(.iconOnly)
  }
}

/// The close button's one place on every sheet and full-screen viewer: the trailing end of
/// the toolbar, after the screen's own actions. Never the leading side, so a reader always
/// finds it in the same corner.
struct OkouCloseToolbarItem: ToolbarContent {
  let action: () -> Void

  var body: some ToolbarContent {
    ToolbarItem(placement: .topBarTrailing) { OkouCloseButton(action: action) }
  }
}
