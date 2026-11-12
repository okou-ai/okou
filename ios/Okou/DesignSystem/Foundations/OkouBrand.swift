import SwiftUI

enum OkouBrand {
  static let symbol = "OkouMark"
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
