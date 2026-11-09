import CCStateSwiftUI
import ChatData
import SwiftUI

/// The partner's own logo in a fixed square slot, so services are recognisable at a glance.
/// Falls back to the product glyph while loading, on failure, and for custom connectors.
struct ConnectorLogo: View {
  let icon: ChatConnectorIcon?
  var fallback = "plug"
  var pointSize = OkouIconSize.partnerLogo
  @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1

  var body: some View {
    let resources = ConnectorIconResources.shared
    StoreProvider(resources.store) {
      if let icon {
        ConnectorLogoValue(icon: icon, fallback: fallback, resources: resources)
      } else {
        ConnectorLogoContent(icon: nil, image: nil, fallback: fallback)
      }
    }
    .id(icon?.url)
    .frame(width: pointSize * scale, height: pointSize * scale)
    .clipShape(RoundedRectangle(cornerRadius: OkouRadius.thumbnail))
    .accessibilityHidden(true)
  }
}

private struct ConnectorLogoValue: View {
  let icon: ChatConnectorIcon
  let fallback: String
  let resources: ConnectorIconResources
  private let read: ConnectorIconRead
  @LoadableValue private var image: Loadable<UIImage>

  init(icon: ChatConnectorIcon, fallback: String, resources: ConnectorIconResources) {
    self.icon = icon
    self.fallback = fallback
    self.resources = resources
    let read = resources.icon(icon.url)
    self.read = read
    _image = LoadableValue(task: read.value)
  }

  var body: some View {
    ConnectorLogoContent(icon: icon, image: image.data, fallback: fallback)
      .onAppear { resources.retryIfNeeded(read) }
  }
}

private struct ConnectorLogoContent: View {
  let icon: ChatConnectorIcon?
  let image: UIImage?
  let fallback: String
  @Environment(\.colorScheme) private var colorScheme

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
