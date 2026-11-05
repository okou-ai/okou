import ChatData
import SwiftUI

/// The partner's own logo in a fixed square slot, so services are recognisable at a glance.
/// Falls back to the product glyph while loading, on failure, and for custom connectors.
struct ConnectorLogo: View {
  let icon: ChatConnectorIcon?
  var fallback = "plug"
  var pointSize = OkouIconSize.partnerLogo
  @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1
  @Environment(\.colorScheme) private var colorScheme

  @State private var image: UIImage?

  var body: some View {
    Group {
      if let image, let icon {
        Image(uiImage: image).resizable().scaledToFit()
          .scaleEffect(icon.scale ?? 1)
          .colorInvert(icon.invertInDarkMode && colorScheme == .dark)
      } else {
        placeholder
      }
    }
    .frame(width: pointSize * scale, height: pointSize * scale)
    .clipShape(RoundedRectangle(cornerRadius: OkouRadius.thumbnail))
    .accessibilityHidden(true)
    .task(id: icon?.url) {
      guard let url = icon?.url else {
        image = nil
        return
      }
      image = ConnectorIconLoader.shared.cachedImage(for: url)
      if image == nil { image = await ConnectorIconLoader.shared.image(for: url) }
    }
  }

  private var placeholder: some View {
    OkouIcon(fallback, size: OkouIconSize.standard)
      .foregroundStyle(OkouColor.mutedForeground)
  }
}

extension View {
  @ViewBuilder fileprivate func colorInvert(_ enabled: Bool) -> some View {
    if enabled { colorInvert() } else { self }
  }
}
