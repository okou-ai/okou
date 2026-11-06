import SwiftUI
import Textual

struct MessageMermaidView: View {
  let code: String
  let original: AttributedString
  let renderer: MessageMermaidRenderer
  let loadsContent: Bool
  @Environment(\.colorScheme) private var colorScheme
  @State private var image: UIImage?
  @State private var failed = false
  @State private var expanded = false
  @State private var zoomStep = 0

  private struct Request: Hashable {
    let code: String
    let dark: Bool
    let loads: Bool
  }

  var body: some View {
    Group {
      if failed {
        StructuredText(code, parser: PreparedMessageParser(content: original))
      } else {
        VStack(alignment: .leading, spacing: OkouSpace.sm) {
          HStack {
            Label("Diagram", okouSymbol: "workflow")
              .font(.okou(.caption)).foregroundStyle(OkouColor.mutedForeground)
            Spacer()
            Button {
              UIPasteboard.general.string = code
            } label: {
              OkouIcon("copy", size: OkouIconSize.inline)
                .foregroundStyle(OkouColor.mutedForeground)
                .frame(
                  width: OkouControl.minimumTarget, height: OkouControl.inlineActionHeight
                )
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Copy diagram source")
          }
          Button {
            zoomStep = 0
            expanded = true
          } label: {
            ZStack {
              Color.clear
              if let image {
                Image(uiImage: image).resizable().scaledToFit().padding(OkouSpace.sm)
              } else {
                ProgressView()
              }
            }
            .aspectRatio(4 / 3, contentMode: .fit)
            .background(OkouColor.stateHover)
            .clipShape(RoundedRectangle(cornerRadius: OkouRadius.control))
            .overlay(alignment: .bottomTrailing) {
              OkouToolbarIcon("maximize-2").padding(OkouSpace.sm)
                .foregroundStyle(
                  OkouColor.mutedForeground)
            }
          }
          .buttonStyle(.plain)
          .disabled(image == nil)
          .accessibilityLabel("Expand diagram")
          DisclosureGroup("Diagram source") {
            ScrollView(.horizontal) {
              Text(code).font(.okou(.caption, design: .monospaced))
                .textSelection(.enabled).padding(.vertical, OkouSpace.sm)
            }
          }
          .font(.okou(.caption)).foregroundStyle(OkouColor.mutedForeground)
        }
        .padding(.vertical, OkouSpace.sm)
      }
    }
    .padding(.bottom, OkouSpace.lg)
    .task(id: Request(code: code, dark: colorScheme == .dark, loads: loadsContent)) {
      guard loadsContent else { return }
      image = nil
      failed = false
      do {
        let data = try await renderer.image(for: code, dark: colorScheme == .dark)
        try Task.checkCancellation()
        image = data.flatMap { UIImage(data: $0) }
        failed = image == nil
      } catch is CancellationError {
        // A retired or offscreen message must not publish its previous request's result.
      } catch {
        failed = true
      }
    }
    .fullScreenCover(isPresented: $expanded) {
      if let image {
        NavigationStack {
          MessageZoomableImage(
            image: image, zoomStep: zoomStep,
            accessibilityLabel: String(localized: "Diagram. Pinch to zoom, or double tap.")
          )
          .background(OkouColor.background)
          .navigationTitle("Diagram")
          .navigationBarTitleDisplayMode(.inline)
          .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
              HStack {
                Button {
                  zoomStep -= 1
                } label: {
                  OkouToolbarIcon("zoom-out")
                }
                .accessibilityLabel("Zoom out")
                Button {
                  zoomStep += 1
                } label: {
                  OkouToolbarIcon("zoom-in")
                }
                .accessibilityLabel("Zoom in")
                Button {
                  UIPasteboard.general.string = code
                } label: {
                  OkouToolbarIcon("copy")
                }
                .accessibilityLabel("Copy diagram source")
              }
            }
            ToolbarSpacer(.fixed, placement: .topBarTrailing)
            OkouCloseToolbarItem { expanded = false }
          }
        }
      }
    }
  }
}
