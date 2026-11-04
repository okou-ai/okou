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
        VStack(alignment: .leading, spacing: 8) {
          HStack {
            Label("Diagram", systemImage: "point.3.connected.trianglepath.dotted")
              .font(.caption).foregroundStyle(.secondary)
            Spacer()
            Button {
              UIPasteboard.general.string = code
            } label: {
              Image(systemName: "doc.on.doc")
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Copy diagram source")
          }
          Button {
            zoomStep = 0
            expanded = true
          } label: {
            ZStack {
              Color.clear
              if let image {
                Image(uiImage: image).resizable().scaledToFit().padding(8)
              } else {
                ProgressView()
              }
            }
            .aspectRatio(4 / 3, contentMode: .fit)
            .background(Color(uiColor: .secondarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(alignment: .bottomTrailing) {
              Image(systemName: "arrow.up.left.and.arrow.down.right")
                .font(.caption).padding(8).foregroundStyle(.secondary)
            }
          }
          .buttonStyle(.plain)
          .disabled(image == nil)
          .accessibilityLabel("Expand diagram")
          DisclosureGroup("Diagram source") {
            ScrollView(.horizontal) {
              Text(code).font(.system(.caption, design: .monospaced))
                .textSelection(.enabled).padding(.vertical, 8)
            }
          }
          .font(.caption).foregroundStyle(.secondary)
        }
        .padding(.vertical, 8)
      }
    }
    .padding(.bottom, 16)
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
          MermaidZoomView(image: image, zoomStep: zoomStep)
            .background(Color(uiColor: .systemBackground))
            .navigationTitle("Diagram")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
              ToolbarItem(placement: .cancellationAction) {
                Button("Done") { expanded = false }
              }
              ToolbarItem(placement: .primaryAction) {
                HStack {
                  Button {
                    zoomStep -= 1
                  } label: {
                    Image(systemName: "minus.magnifyingglass")
                  }
                  .accessibilityLabel("Zoom out")
                  Button {
                    zoomStep += 1
                  } label: {
                    Image(systemName: "plus.magnifyingglass")
                  }
                  .accessibilityLabel("Zoom in")
                  Button {
                    UIPasteboard.general.string = code
                  } label: {
                    Image(systemName: "doc.on.doc")
                  }
                  .accessibilityLabel("Copy diagram source")
                }
              }
            }
        }
      }
    }
  }
}

private struct MermaidZoomView: UIViewRepresentable {
  let image: UIImage
  let zoomStep: Int

  func makeUIView(context: Context) -> MermaidScrollView { MermaidScrollView(image: image) }
  func updateUIView(_ view: MermaidScrollView, context: Context) { view.adjustZoom(to: zoomStep) }
}

private final class MermaidScrollView: UIScrollView, UIScrollViewDelegate {
  private let diagram: UIImageView
  private let imageSize: CGSize
  private var viewport: CGSize = .zero
  private var zoomStep = 0

  init(image: UIImage) {
    diagram = UIImageView(image: image)
    imageSize = image.size
    super.init(frame: .zero)
    delegate = self
    contentInsetAdjustmentBehavior = .never
    diagram.frame = CGRect(origin: .zero, size: image.size)
    diagram.isAccessibilityElement = true
    diagram.accessibilityLabel = String(localized: "Diagram. Pinch to zoom, or double tap.")
    addSubview(diagram)
    let doubleTap = UITapGestureRecognizer(target: self, action: #selector(toggleZoom(_:)))
    doubleTap.numberOfTapsRequired = 2
    addGestureRecognizer(doubleTap)
  }

  required init?(coder: NSCoder) { nil }

  override func layoutSubviews() {
    super.layoutSubviews()
    guard bounds.size != viewport, bounds.width > 0, bounds.height > 0 else { return }
    viewport = bounds.size
    let fit = min(bounds.width / imageSize.width, bounds.height / imageSize.height)
    minimumZoomScale = min(1, fit)
    maximumZoomScale = max(4, fit * 8)
    setZoomScale(minimumZoomScale, animated: false)
    centerDiagram()
  }

  func viewForZooming(in scrollView: UIScrollView) -> UIView? { diagram }
  func scrollViewDidZoom(_ scrollView: UIScrollView) { centerDiagram() }

  func adjustZoom(to step: Int) {
    guard step != zoomStep else { return }
    let factor = pow(1.6, Double(step - zoomStep))
    zoomStep = step
    setZoomScale(min(maximumZoomScale, max(minimumZoomScale, zoomScale * factor)), animated: true)
  }

  private func centerDiagram() {
    contentInset = UIEdgeInsets(
      top: max(0, (bounds.height - contentSize.height) / 2),
      left: max(0, (bounds.width - contentSize.width) / 2),
      bottom: 0, right: 0)
  }

  @objc private func toggleZoom(_ gesture: UITapGestureRecognizer) {
    if zoomScale > minimumZoomScale * 1.1 {
      setZoomScale(minimumZoomScale, animated: true)
    } else {
      let scale = min(maximumZoomScale, minimumZoomScale * 3)
      let point = gesture.location(in: diagram)
      let size = CGSize(width: bounds.width / scale, height: bounds.height / scale)
      zoom(
        to: CGRect(
          x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width,
          height: size.height), animated: true)
    }
  }
}
