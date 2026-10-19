import ClerkKitUI
import SwiftUI

struct SignInPage<Content: View>: View {
  let webURL: URL
  @ViewBuilder let content: () -> Content
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  var body: some View {
    GeometryReader { geometry in
      VStack(spacing: 24) {
        content()
          .frame(maxWidth: 400)
          .background(SignInStyle.card, in: RoundedRectangle(cornerRadius: 20))
          .overlay {
            RoundedRectangle(cornerRadius: 20)
              .strokeBorder(Color.primary.opacity(0.08), lineWidth: 0.5)
              .allowsHitTesting(false)
          }
          .clipShape(RoundedRectangle(cornerRadius: 20))

        if geometry.size.height > 500 && !dynamicTypeSize.isAccessibilitySize {
          Text("Use your existing Okou account. Manage your account on the web.")
            .font(.footnote)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      .padding(24)
      .padding(.top, 56)
      .frame(width: geometry.size.width, height: geometry.size.height)
    }
    .overlay(alignment: .topLeading) {
      Link(destination: webURL) { SignInWordmark(width: 86) }
        .accessibilityLabel("Okou home")
        .padding(24)
    }
    .background { SignInBackground().ignoresSafeArea() }
  }
}

struct SignInWordmark: View {
  let width: CGFloat

  var body: some View {
    Image("SignInWordmark")
      .resizable()
      .scaledToFit()
      .frame(width: width, height: width * 512 / 1933.84)
      .foregroundStyle(.primary)
      .accessibilityLabel("Okou")
  }
}

enum SignInStyle {
  static let card = Color("SignInCard")
  static let primary = Color("SignInPrimary")

  @MainActor
  static func makeTheme() -> ClerkTheme {
    var colors = ClerkTheme.Colors(
      primary: primary, background: card, input: card,
      foreground: .primary, mutedForeground: .secondary,
      primaryForeground: Color(uiColor: .systemBackground), inputForeground: .primary,
      neutral: .primary, ring: primary,
      muted: Color(uiColor: .secondarySystemBackground), secondaryButtonBackground: card,
      secondaryButtonForeground: .primary, border: .primary)
    colors.inputBorder = Color.primary.opacity(0.25)
    colors.inputBorderFocused = primary.opacity(0.5)
    return ClerkTheme(colors: colors, design: .init(borderRadius: 10))
  }
}

private struct SignInBackground: View {
  var body: some View {
    ZStack {
      Color(uiColor: .systemBackground)
      LinearGradient(
        colors: [
          Color(red: 1, green: 0.78, blue: 0.69).opacity(0.2),
          Color(red: 0.65, green: 0.87, blue: 1).opacity(0.15),
          Color(red: 1, green: 0.91, blue: 0.64).opacity(0.2),
        ],
        startPoint: .topLeading, endPoint: .bottomTrailing)
      Canvas { context, size in
        var grid = Path()
        for x in stride(from: CGFloat.zero, through: size.width, by: 48) {
          grid.move(to: CGPoint(x: x, y: 0))
          grid.addLine(to: CGPoint(x: x, y: size.height))
        }
        for y in stride(from: CGFloat.zero, through: size.height, by: 48) {
          grid.move(to: CGPoint(x: 0, y: y))
          grid.addLine(to: CGPoint(x: size.width, y: y))
        }
        context.stroke(grid, with: .color(SignInStyle.primary.opacity(0.05)), lineWidth: 0.5)
      }
    }
    .accessibilityHidden(true)
  }
}
