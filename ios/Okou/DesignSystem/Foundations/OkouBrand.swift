import SwiftUI

enum OkouBrand {
  static let symbol = "OkouMark"
  /// `OkouMark.svg` draws its artwork across 418.43 of its 512 pt canvas. Beside company marks
  /// drawn edge to edge, divide its frame by this to show the artwork at the same size.
  static let symbolArtworkRatio: CGFloat = 418.43 / 512
  static let wordmark = "SignInWordmark"
}

struct OkouWordmark: View {
  var width: CGFloat = 96

  var body: some View {
    Image(OkouBrand.wordmark)
      .resizable()
      .scaledToFit()
      .frame(width: width, height: width * 512 / 1933.84)
      .foregroundStyle(OkouColor.foreground)
      .accessibilityLabel("Okou")
  }
}
