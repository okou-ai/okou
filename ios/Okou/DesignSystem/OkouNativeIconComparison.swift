#if DEBUG
  import SwiftUI
  import UIKit

  /// SF Symbols are native comparison specimens only, never product replacements.
  struct OkouNativeIconComparison: View {
    private let pairs = [
      ("search", "magnifyingglass"), ("settings", "gearshape"),
      ("plus", "plus"), ("x", "xmark"),
    ]

    var body: some View {
      VStack(alignment: .leading, spacing: OkouSpace.lg) {
        Text("Native icon calibration").font(.okou(.headline))
        Text("SF Symbols and Okou in the same native controls.")
          .font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
        Grid(horizontalSpacing: OkouSpace.xl, verticalSpacing: OkouSpace.sm) {
          GridRow {
            Text("Control")
            Text("Native")
            Text("Okou")
          }
          .font(.okou(.caption))
          ForEach(pairs, id: \.0) { icon, symbol in
            GridRow {
              Text(icon).font(.okou(.subheadline)).frame(maxWidth: .infinity, alignment: .leading)
              Button {
              } label: {
                Image(systemName: symbol)
              }
              .buttonStyle(.glass).buttonBorderShape(.circle)
              .accessibilityLabel("Native " + icon)
              Button {
              } label: {
                OkouToolbarIcon(icon)
              }
              .buttonStyle(.glass).buttonBorderShape(.circle)
              .accessibilityLabel("Okou " + icon)
            }
          }
        }
        HStack(spacing: OkouSpace.xl) {
          Text("Accessory").font(.okou(.caption))
          Image(systemName: "chevron.right").font(.caption)
          OkouIcon("chevron-right", size: OkouIconSize.accessory)
          Text("Stop").font(.okou(.caption))
          Image(systemName: "stop.fill").font(.body)
          OkouIcon("square", size: OkouIconSize.inline)
        }
        NativeMenuComparison().frame(height: OkouControl.minimumTarget)
        HStack(spacing: OkouSpace.xl) {
          Label("Native row", systemImage: "gearshape")
          Label("Okou row", okouSymbol: "settings")
        }.font(.body)
      }
    }
  }

  private struct NativeMenuComparison: UIViewRepresentable {
    func makeUIView(context: Context) -> UIButton {
      let button = UIButton(type: .system)
      var configuration = UIButton.Configuration.glass()
      configuration.title = "Compare native / Okou menu"
      button.configuration = configuration
      button.showsMenuAsPrimaryAction = true
      button.accessibilityIdentifier = "native-icon-comparison-menu"
      let examples = [
        ("Unpin chat", "pin.slash", "pin-off"),
        ("Rename", "pencil", "pencil"),
        ("Mute chat", "bell.slash", "bell-off"),
        ("Archive chat", "archivebox", "archive"),
      ]
      button.menu = UIMenu(children: [
        UIMenu(
          title: "Native", options: .displayInline,
          children: examples.map { title, symbol, _ in
            UIAction(title: title, image: UIImage(systemName: symbol)) { _ in }
          }),
        UIMenu(
          title: "Okou", options: .displayInline,
          children: examples.map { title, _, icon in
            UIAction(title: title, image: OkouIcon.uiImage(icon)) { _ in }
          }),
      ])
      return button
    }

    func updateUIView(_ button: UIButton, context: Context) {
      button.tintColor = UIColor(OkouColor.foreground)
    }
  }
#endif
