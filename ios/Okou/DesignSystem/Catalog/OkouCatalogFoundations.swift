#if DEBUG
  import SwiftUI

  struct OkouCatalogColorPage: View {
    let close: (() -> Void)?

    var body: some View {
      OkouCatalogPage(.color, close: close) {
        OkouCatalogSection("Surfaces") {
          OkouCatalogSwatches([
            ("Background", OkouColor.background), ("Card", OkouColor.card),
            ("Sidebar", OkouColor.sidebar), ("State hover", OkouColor.stateHover),
            ("Border", OkouColor.border),
          ])
        }
        OkouCatalogSection("Text") {
          OkouCatalogSwatches([
            ("Foreground", OkouColor.foreground), ("Muted foreground", OkouColor.mutedForeground),
            ("Trailing value", OkouColor.trailingValue), ("Placeholder", OkouColor.placeholder),
          ])
        }
        OkouCatalogSection("Action & brand") {
          OkouCatalogSwatches([
            ("Primary", OkouColor.primary), ("Brand text", OkouColor.brandText),
            ("Link", OkouColor.link), ("Interrupt", OkouColor.interrupt),
            ("Destructive", OkouColor.destructive),
          ])
        }
        OkouCatalogSection("Status") {
          OkouCatalogSwatches([
            ("Running", OkouStatusColor.running), ("Success", OkouStatusColor.success),
            ("Warning", OkouStatusColor.warning),
          ])
        }
      }
    }
  }

  /// Colour roles as named swatches, each outlined so white reads on white.
  struct OkouCatalogSwatches: View {
    let swatches: [(name: String, color: Color)]

    init(_ swatches: [(name: String, color: Color)]) {
      self.swatches = swatches
    }

    var body: some View {
      LazyVGrid(columns: [GridItem(.adaptive(minimum: 120))], spacing: OkouSpace.md) {
        ForEach(swatches, id: \.name) { swatch in
          VStack(alignment: .leading, spacing: OkouSpace.sm) {
            RoundedRectangle(cornerRadius: OkouRadius.small).fill(swatch.color).frame(height: 48)
              .overlay {
                RoundedRectangle(cornerRadius: OkouRadius.small).strokeBorder(
                  OkouColor.border, lineWidth: 1)
              }
            Text(swatch.name).font(.okou(.caption))
          }
        }
      }
    }
  }

  struct OkouCatalogTypographyPage: View {
    let close: (() -> Void)?

    var body: some View {
      OkouCatalogPage(.typography, close: close) {
        OkouCatalogSection("Type roles") {
          Text("Geist · Title").font(.okou(.title))
          Text("Headline · 17 pt").font(.okou(.headline))
          Text("Body · 17 pt · Dynamic Type").font(.okou(.body))
          Text("Supporting text · 13 pt").font(.okou(.footnote))
            .foregroundStyle(OkouColor.mutedForeground)
          Text("Geist Mono · code").font(.okou(.body, design: .monospaced))
          Text("Keep going · run-section label")
            .font(.okou(.subheadline, design: .serif).italic())
            .foregroundStyle(OkouColor.mutedForeground.opacity(0.5))
        }
      }
    }
  }

  struct OkouCatalogIconographyPage: View {
    let close: (() -> Void)?

    var body: some View {
      OkouCatalogPage(.iconography, close: close) {
        OkouNativeIconComparison()
        OkouCatalogSection("Lucide · native optical sizing") {
          LazyVGrid(columns: [GridItem(.adaptive(minimum: 92))], spacing: OkouSpace.lg) {
            ForEach(OkouIconAssets.names, id: \.self) { name in
              VStack(spacing: OkouSpace.sm) {
                OkouIcon(name, size: OkouIconSize.large)
                Text(name).font(.okou(.caption2)).multilineTextAlignment(.center)
              }
              .frame(maxWidth: .infinity, minHeight: 72)
              .accessibilityElement(children: .ignore).accessibilityLabel(name)
            }
          }
        }
      }
    }
  }

  struct OkouCatalogMaterialsPage: View {
    let close: (() -> Void)?
    @State private var showsSheet = false

    var body: some View {
      OkouCatalogPage(.materials, close: close) {
        OkouCatalogSection("Card surface") {
          VStack(alignment: .leading, spacing: OkouSpace.sm) {
            Label("Card title", okouSymbol: "file-text").font(.okou(.headline))
            Text("Use semantic colors and native radius tokens.")
              .foregroundStyle(OkouColor.mutedForeground)
          }
          .padding(OkouSpace.lg).frame(maxWidth: .infinity, alignment: .leading)
          .modifier(OkouSurfaceStyle())
        }
        OkouCatalogSection("Floating panel") {
          VStack(alignment: .leading, spacing: 0) {
            Text("Workflows").font(.okou(.footnote).weight(.medium))
              .foregroundStyle(OkouColor.mutedForeground)
              .padding(.horizontal, OkouSpace.lg).padding(.vertical, OkouSpace.sm)
            ForEach(["Daily brief", "Release notes"], id: \.self) { name in
              Label(name, okouSymbol: "workflow").font(.okou(.subheadline).weight(.medium))
                .padding(.horizontal, OkouSpace.lg)
                .frame(
                  maxWidth: .infinity, minHeight: OkouControl.minimumTarget, alignment: .leading)
            }
          }
          .padding(.bottom, OkouSpace.sm)
          .modifier(OkouFloatingPanelStyle())
        }
        OkouCatalogSection("Glass") {
          // Every glass control is drawn on the exact 44 pt shape.
          HStack(spacing: OkouSpace.md) {
            ForEach(["menu", "list-filter"], id: \.self) { icon in
              Button {
              } label: {
                OkouToolbarIcon(icon)
                  .modifier(OkouUnreadBadge(isVisible: icon == "menu"))
                  .modifier(OkouGlassControl(shape: .circle))
              }
              .buttonStyle(.plain)
              .accessibilityLabel(icon)
            }
          }
        }
        OkouCatalogSection("Sheets") {
          Button("Open native scrolling sheet") { showsSheet = true }
            .buttonStyle(.bordered)
        }
      }
      .sheet(isPresented: $showsSheet) {
        NavigationStack {
          List {
            Section("Native scroll transition") {
              ForEach(1..<25) { index in
                Label("Example row \(index)", okouSymbol: "message-circle")
              }
            }
          }
          // Every sheet's grouped ground, so this sheet presents as the product's do.
          .okouGroupedBackground()
          .navigationTitle("Component reference")
          .navigationBarTitleDisplayMode(.inline)
          .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
              OkouCloseButton { showsSheet = false }
            }
          }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .okouSheetBackground()
      }
    }
  }
#endif
