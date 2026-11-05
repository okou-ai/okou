import SwiftUI

struct SignInPage<Content: View>: View {
  let webURL: URL
  @ViewBuilder let content: () -> Content

  var body: some View {
    GeometryReader { geometry in
      ScrollView {
        VStack(alignment: .leading, spacing: OkouSpace.hero) {
          Link(destination: webURL) { OkouWordmark(width: 96) }
            .accessibilityLabel("Okou home")
            .frame(minHeight: OkouControl.minimumTarget)
          Spacer(minLength: OkouSpace.xl)
          content()
          Spacer(minLength: OkouSpace.xl)
        }
        .frame(maxWidth: OkouControl.readableWidth, alignment: .leading)
        .padding(OkouControl.pageInset)
        .frame(maxWidth: .infinity, minHeight: geometry.size.height, alignment: .top)
      }
      .scrollBounceBehavior(.basedOnSize)
    }
    .background(OkouColor.background.ignoresSafeArea())
  }
}
